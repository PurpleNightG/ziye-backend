import express from 'express'
import path from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import {
  resolveLocalDocsRoot,
  listRecursiveLocal,
  readLocalFile,
  readLocalIndex,
  writeLocalIndex,
  writeLocalFile,
} from '../utils/docsLocal.js'

const router = express.Router()

const GITHUB_API = 'https://api.github.com'
const OWNER = process.env.GITHUB_OWNER || 'PurpleNightG'
const REPO = process.env.GITHUB_REPO || 'PurpleNightG.github.io'
const BRANCH = process.env.GITHUB_BRANCH || 'main'
const DOCS_PATH = 'public/docs'
const VERSION_PATH = 'public/version.json'
/** 拉取 GitHub 超时后回退本地缓存（毫秒） */
const GITHUB_TIMEOUT_MS = Number(process.env.DOCS_GITHUB_TIMEOUT_MS || 6000)

function canUseGithub() {
  return !!process.env.GITHUB_TOKEN
}

async function githubFetch(url, options = {}) {
  let res
  try {
    res = await fetch(url, options)
  } catch (error) {
    throw new Error(`GitHub API 网络错误: ${error.message}`)
  }
  return res
}

function withTimeout(promise, ms, label = 'GitHub') {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
    }),
  ])
}

/** 把线上内容落到本地，供离线/超时使用 */
async function cacheDocToLocal(filename, content) {
  const root = resolveLocalDocsRoot()
  if (!root) return
  await writeLocalFile(root, filename, content)

  // 便携包同时写一份到 dist/docs，供静态服务直接读
  const distDocs = path.join(path.dirname(root), 'dist', 'docs')
  const distParent = path.dirname(distDocs)
  if (existsSync(distParent)) {
    await writeLocalFile(distDocs, filename, content)
  }
}

async function cacheIndexToLocal(indexData) {
  const root = resolveLocalDocsRoot()
  if (!root) return
  await writeLocalIndex(root, indexData)
  const distDocs = path.join(path.dirname(root), 'dist', 'docs')
  if (existsSync(path.dirname(distDocs))) {
    await writeLocalIndex(distDocs, indexData)
  }
}

async function cacheVersionToLocal(versionData) {
  const root = resolveLocalDocsRoot()
  if (!root) return
  const payload = `${JSON.stringify(versionData, null, 2)}\n`
  const distVersion = pathResolveVersionNearDocs(root)
  if (distVersion) {
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(path.dirname(distVersion), { recursive: true })
    await writeFile(distVersion, payload, 'utf-8')
  }
}

/**
 * 策略：能连 GitHub 则拉取并缓存本地；超时/失败用本地。
 */
async function readGithubOrLocal(githubFn, localFn, { cacheWriter } = {}) {
  const localRoot = resolveLocalDocsRoot()
  if (canUseGithub()) {
    try {
      const data = await withTimeout(githubFn(), GITHUB_TIMEOUT_MS)
      if (cacheWriter) {
        try {
          await cacheWriter(data)
        } catch (error) {
          console.warn('缓存文档到本地失败:', error.message)
        }
      }
      return { source: 'github', data }
    } catch (error) {
      console.warn('GitHub 文档拉取失败/超时，回退本地副本:', error.message)
      if (localRoot) return { source: 'local-fallback', data: await localFn(localRoot) }
      throw error
    }
  }
  if (localRoot) return { source: 'local-fallback', data: await localFn(localRoot) }
  throw new Error('未配置 GITHUB_TOKEN，请在 server/.env 中设置')
}

function getHeaders() {
  return {
    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'PurpleNight-Admin'
  }
}

async function getFileSha(filePath) {
  try {
    const res = await githubFetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BRANCH}`, {
      headers: getHeaders()
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.sha || null
  } catch {
    return null
  }
}

// 递归列出目录内容，返回嵌套树结构
async function listRecursive(dirPath) {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${dirPath}?ref=${BRANCH}`,
    { headers: getHeaders() }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || `GitHub API 错误 ${res.status}`)
  }
  const items = await res.json()
  if (!Array.isArray(items)) {
    throw new Error('GitHub API 返回格式异常')
  }

  const result = []
  for (const item of items) {
    if (item.name === 'index.json') continue
    if (item.type === 'file' && item.name.endsWith('.md')) {
      const relPath = item.path.replace(`${DOCS_PATH}/`, '')
      result.push({ name: item.name, path: relPath, sha: item.sha, size: item.size, type: 'file' })
    } else if (item.type === 'dir') {
      const children = await listRecursive(item.path)
      const relPath = item.path.replace(`${DOCS_PATH}/`, '') + '/'
      result.push({ name: item.name, path: relPath, type: 'dir', children })
    }
  }
  // 文件夹排前面，同类型按名称排序
  result.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return result
}

// 递归构建 index.json 结构（只保留 name/path/type/children，省略 sha/size）
function buildIndexTree(tree) {
  return tree.map(item => {
    if (item.type === 'dir') {
      return { name: item.name, path: item.path, type: 'dir', children: buildIndexTree(item.children || []) }
    }
    return { name: item.name.replace('.md', ''), path: item.path, type: 'file' }
  })
}

// 合并已有排序（existing）与最新文件列表（auto），保留用户自定义顺序
// - existing 中存在且 auto 中仍有的条目：保持原顺序
// - auto 中新增（existing 没有）的条目：追加到末尾
// - existing 中已删除（auto 中不存在）的条目：丢弃
function mergeIndexOrder(existing, auto) {
  const autoMap = new Map(auto.map(item => [item.path, item]))
  const result = []
  const used = new Set()
  for (const ex of existing) {
    if (autoMap.has(ex.path)) {
      const autoItem = autoMap.get(ex.path)
      used.add(ex.path)
      if (ex.type === 'dir' && autoItem.type === 'dir') {
        const merged = {
          ...autoItem,
          children: mergeIndexOrder(ex.children || [], autoItem.children || []),
        }
        if (ex.visibility) merged.visibility = ex.visibility
        result.push(merged)
      } else {
        // Preserve visibility set by the admin
        const merged = { ...autoItem }
        if (ex.visibility) merged.visibility = ex.visibility
        result.push(merged)
      }
    }
  }
  for (const item of auto) {
    if (!used.has(item.path)) result.push(item)
  }
  return result
}

async function updateIndex() {
  try {
    const tree = await listRecursive(DOCS_PATH)
    const autoIndex = buildIndexTree(tree)

    // 尝试读取现有 index.json 以保留用户自定义排序
    let finalIndex = autoIndex
    try {
      const existingRes = await githubFetch(
        `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/index.json?ref=${BRANCH}`,
        { headers: getHeaders() }
      )
      if (existingRes.ok) {
        const existingData = await existingRes.json()
        const existingIndex = JSON.parse(
          Buffer.from(existingData.content.replace(/\n/g, ''), 'base64').toString('utf-8')
        )
        finalIndex = mergeIndexOrder(existingIndex, autoIndex)
      }
    } catch { /* 读取失败则使用自动排序 */ }

    const encoded = Buffer.from(JSON.stringify(finalIndex, null, 2), 'utf-8').toString('base64')
    const sha = await getFileSha(`${DOCS_PATH}/index.json`)
    await githubFetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/index.json`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ message: 'docs: update index', content: encoded, branch: BRANCH, ...(sha ? { sha } : {}) })
    })
  } catch (e) {
    console.error('更新 index.json 失败:', e)
  }
}

async function updateVersion() {
  try {
    const encoded = Buffer.from(JSON.stringify({ version: Date.now().toString() }, null, 2), 'utf-8').toString('base64')
    const sha = await getFileSha(VERSION_PATH)
    await githubFetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${VERSION_PATH}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ message: 'docs: bump version', content: encoded, branch: BRANCH, ...(sha ? { sha } : {}) })
    })
  } catch (e) {
    console.error('更新 version.json 失败:', e)
  }
}

/** 文档版本号（供本地版 / 前端轮询：GitHub 成功则缓存本地，超时用本地） */
router.get('/version', async (req, res) => {
  try {
    const { source, data } = await readGithubOrLocal(
      async () => {
        const response = await githubFetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${VERSION_PATH}?ref=${BRANCH}`,
          { headers: getHeaders() }
        )
        if (!response.ok) throw new Error('version.json 不存在')
        const fileData = await response.json()
        const text = Buffer.from(fileData.content.replace(/\n/g, ''), 'base64').toString('utf-8')
        return JSON.parse(text)
      },
      async (root) => {
        const candidates = [
          pathResolveVersionNearDocs(root),
          path.join(root, 'version.json'),
        ]
        for (const filePath of candidates) {
          if (!filePath) continue
          try {
            const raw = await readFile(filePath, 'utf-8')
            return JSON.parse(raw)
          } catch {
            // try next
          }
        }
        return { version: '0' }
      },
      { cacheWriter: (versionData) => cacheVersionToLocal(versionData) }
    )
    res.json({ success: true, data, source })
  } catch (error) {
    console.error('获取文档版本失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

function pathResolveVersionNearDocs(docsRoot) {
  // portable: app/docs → app/dist/version.json；dev: public/docs → public/version.json
  const parent = path.dirname(docsRoot)
  const distVersion = path.join(parent, 'dist', 'version.json')
  const publicVersion = path.join(parent, 'version.json')
  if (existsSync(distVersion)) return distVersion
  if (existsSync(publicVersion)) return publicVersion
  return null
}

// 递归删除目录下所有文件
async function deleteDirectoryRecursive(dirPath) {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${dirPath}?ref=${BRANCH}`,
    { headers: getHeaders() }
  )
  if (!res.ok) return
  const items = await res.json()
  if (!Array.isArray(items)) return
  for (const item of items) {
    if (item.type === 'dir') {
      await deleteDirectoryRecursive(item.path)
    } else {
      await githubFetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${item.path}`, {
        method: 'DELETE',
        headers: getHeaders(),
        body: JSON.stringify({ message: `docs: delete ${item.name}`, sha: item.sha, branch: BRANCH })
      })
    }
  }
}

// 列出文件树（管理端用）
router.get('/list', async (req, res) => {
  try {
    const { source, data } = await readGithubOrLocal(
      () => listRecursive(DOCS_PATH),
      (root) => listRecursiveLocal(root)
    )
    res.json({ success: true, data, source })
  } catch (error) {
    console.error('列出文档失败:', error)
    res.status(error.message.includes('未配置') ? 503 : 500).json({ success: false, message: error.message })
  }
})

function encodeGithubContentsPath(filePath) {
  return String(filePath)
    .split('/')
    .filter((part, index) => part || index === 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

// 获取单个文件内容（filename 支持 folder/file.md 格式）
router.get('/file', async (req, res) => {
  try {
    const { filename } = req.query
    if (!filename) return res.status(400).json({ success: false, message: '缺少 filename 参数' })
    const { source, data } = await readGithubOrLocal(
      async () => {
        const response = await githubFetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${encodeGithubContentsPath(`${DOCS_PATH}/${filename}`)}?ref=${BRANCH}`,
          { headers: getHeaders() }
        )
        if (!response.ok) throw new Error('文件不存在')
        const fileData = await response.json()
        const content = Buffer.from(fileData.content.replace(/\n/g, ''), 'base64').toString('utf-8')
        return { content, sha: fileData.sha, name: fileData.name }
      },
      (root) => readLocalFile(root, filename),
      {
        cacheWriter: async (fileData) => {
          await cacheDocToLocal(filename, fileData.content)
        },
      }
    )
    res.json({ success: true, data, source })
  } catch (error) {
    console.error('获取文档内容失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

// 创建或更新文件（filename 支持 folder/file.md）
router.put('/file', async (req, res) => {
  try {
    const { filename, content, sha } = req.body
    if (!filename || content === undefined) {
      return res.status(400).json({ success: false, message: '缺少 filename 或 content 参数' })
    }
    if (!canUseGithub()) {
      return res.status(503).json({ success: false, message: '未配置 GITHUB_TOKEN，无法保存到在线文档' })
    }
    const encoded = Buffer.from(content, 'utf-8').toString('base64')
    const response = await githubFetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/${filename}`,
      {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ message: `docs: update ${filename}`, content: encoded, branch: BRANCH, ...(sha ? { sha } : {}) })
      }
    )
    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.message || '保存文件失败')
    }
    await updateIndex()
    await updateVersion()
    res.json({ success: true, message: '文件保存成功，GitHub Pages 正在重新部署（约1分钟后生效）' })
  } catch (error) {
    console.error('保存文档失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

// 删除文件（filename 支持 folder/file.md）
router.delete('/file', async (req, res) => {
  try {
    const { filename, sha } = req.body
    if (!filename || !sha) {
      return res.status(400).json({ success: false, message: '缺少 filename 或 sha 参数' })
    }
    if (!canUseGithub()) {
      return res.status(503).json({ success: false, message: '未配置 GITHUB_TOKEN，无法删除在线文档' })
    }
    const response = await githubFetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/${filename}`,
      {
        method: 'DELETE',
        headers: getHeaders(),
        body: JSON.stringify({ message: `docs: delete ${filename}`, sha, branch: BRANCH })
      }
    )
    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.message || '删除文件失败')
    }
    await updateIndex()
    await updateVersion()
    res.json({ success: true, message: '文件删除成功' })
  } catch (error) {
    console.error('删除文档失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

// 删除整个文件夹（递归删除所有子文件）
router.delete('/folder', async (req, res) => {
  try {
    const { folderPath } = req.body
    if (!folderPath) return res.status(400).json({ success: false, message: '缺少 folderPath 参数' })
    if (!canUseGithub()) {
      return res.status(503).json({ success: false, message: '未配置 GITHUB_TOKEN，无法删除在线文档' })
    }
    await deleteDirectoryRecursive(`${DOCS_PATH}/${folderPath}`)
    await updateIndex()
    await updateVersion()
    res.json({ success: true, message: '文件夹删除成功' })
  } catch (error) {
    console.error('删除文件夹失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

// 批量重命名/移动文件（一次提交）
router.post('/batch-rename', async (req, res) => {
  try {
    const { operations } = req.body
    // operations: [{ oldPath, newPath, sha }]
    if (!Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ success: false, message: '缺少 operations 参数' })
    }
    if (!canUseGithub()) {
      return res.status(503).json({ success: false, message: '未配置 GITHUB_TOKEN，无法重命名在线文档' })
    }

    const errors = []
    for (const op of operations) {
      const { oldPath, newPath, sha } = op
      if (!oldPath || !newPath || !sha) { errors.push(`参数不完整: ${JSON.stringify(op)}`); continue }
      if (oldPath === newPath) continue
      try {
        // 获取原文件内容
        const getRes = await githubFetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/${oldPath}?ref=${BRANCH}`,
          { headers: getHeaders() }
        )
        if (!getRes.ok) { errors.push(`获取 ${oldPath} 失败`); continue }
        const fileData = await getRes.json()
        const rawContent = fileData.content.replace(/\n/g, '')

        // 创建新路径文件
        const createRes = await githubFetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/${newPath}`,
          {
            method: 'PUT',
            headers: getHeaders(),
            body: JSON.stringify({
              message: `docs: rename ${oldPath} -> ${newPath}`,
              content: rawContent,
              branch: BRANCH
            })
          }
        )
        if (!createRes.ok) { const e = await createRes.json(); errors.push(`创建 ${newPath} 失败: ${e.message}`); continue }

        // 删除旧文件
        await githubFetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/${oldPath}`,
          {
            method: 'DELETE',
            headers: getHeaders(),
            body: JSON.stringify({ message: `docs: remove ${oldPath}`, sha, branch: BRANCH })
          }
        )
      } catch (e) {
        errors.push(`处理 ${oldPath} 时出错: ${e.message}`)
      }
    }

    // 统一更新索引和版本（只调用一次）
    await updateIndex()
    await updateVersion()

    if (errors.length > 0) {
      res.json({ success: true, message: `完成，但部分操作失败:\n${errors.join('\n')}` })
    } else {
      res.json({ success: true, message: `成功重命名/移动 ${operations.length} 个文件` })
    }
  } catch (error) {
    console.error('批量重命名失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

// 读取当前 index.json（管理端用，保留 visibility 等自定义字段）
router.get('/index', async (req, res) => {
  try {
    const { source, data } = await readGithubOrLocal(
      async () => {
        const response = await githubFetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/index.json?ref=${BRANCH}`,
          { headers: getHeaders() }
        )
        if (!response.ok) return []
        const fileData = await response.json()
        return JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ''), 'base64').toString('utf-8'))
      },
      (root) => readLocalIndex(root),
      {
        cacheWriter: async (indexData) => {
          if (Array.isArray(indexData)) await cacheIndexToLocal(indexData)
        },
      }
    )
    res.json({ success: true, data, source })
  } catch (error) {
    console.error('读取 index.json 失败:', error)
    res.json({ success: true, data: [] })
  }
})

// 更新单个文件的可见性（public | private）
router.put('/visibility', async (req, res) => {
  try {
    const { path: filePath, visibility } = req.body
    if (!filePath || !['public', 'private'].includes(visibility)) {
      return res.status(400).json({ success: false, message: '参数错误' })
    }
    if (!canUseGithub()) {
      return res.status(503).json({ success: false, message: '未配置 GITHUB_TOKEN，无法更新在线文档' })
    }

    // 读取现有 index.json
    const getRes = await githubFetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/index.json?ref=${BRANCH}`,
      { headers: getHeaders() }
    )
    let index = []
    let sha = null
    if (getRes.ok) {
      const data = await getRes.json()
      sha = data.sha
      index = JSON.parse(Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8'))
    }

    // 递归更新目标路径的 visibility
    function setVisibility(items) {
      return items.map(item => {
        if (item.path === filePath) {
          return visibility === 'public'
            ? (({ visibility: _, ...rest }) => rest)(item)  // 公开则移除字段
            : { ...item, visibility }
        }
        if (item.type === 'dir' && item.children) {
          return { ...item, children: setVisibility(item.children) }
        }
        return item
      })
    }
    const updated = setVisibility(index)

    const encoded = Buffer.from(JSON.stringify(updated, null, 2), 'utf-8').toString('base64')
    const putRes = await githubFetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/index.json`,
      {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ message: `docs: set ${filePath} visibility=${visibility}`, content: encoded, branch: BRANCH, ...(sha ? { sha } : {}) })
      }
    )
    if (!putRes.ok) {
      const err = await putRes.json()
      throw new Error(err.message || '保存失败')
    }
    res.json({ success: true, message: '可见性已更新' })
  } catch (error) {
    console.error('更新可见性失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

// 保存自定义排序（管理端拖拽排序后直接写入 index.json）
router.put('/order', async (req, res) => {
  try {
    const { index } = req.body
    if (!Array.isArray(index)) return res.status(400).json({ success: false, message: '缺少 index 参数' })
    if (!canUseGithub()) {
      return res.status(503).json({ success: false, message: '未配置 GITHUB_TOKEN，无法保存在线文档排序' })
    }
    const encoded = Buffer.from(JSON.stringify(index, null, 2), 'utf-8').toString('base64')
    const sha = await getFileSha(`${DOCS_PATH}/index.json`)
    const response = await githubFetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${DOCS_PATH}/index.json`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ message: 'docs: reorder index', content: encoded, branch: BRANCH, ...(sha ? { sha } : {}) })
    })
    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.message || '保存排序失败')
    }
    const localRoot = resolveLocalDocsRoot()
    if (localRoot) {
      try {
        await writeLocalIndex(localRoot, index)
      } catch (e) {
        console.warn('同步本地 index.json 失败:', e.message)
      }
    }
    await updateVersion()
    res.json({ success: true, message: '排序已保存，GitHub Pages 约1分钟后生效' })
  } catch (error) {
    console.error('保存排序失败:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

export default router
