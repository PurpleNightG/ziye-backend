import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import crypto from 'crypto'

export function resolveLocalDocsRoot() {
  if (process.env.DOCS_LOCAL_PATH) {
    return path.resolve(process.env.DOCS_LOCAL_PATH)
  }
  const devPath = path.resolve(process.cwd(), '../public/docs')
  if (existsSync(devPath)) return devPath
  const portablePath = path.resolve(process.cwd(), '../docs')
  if (existsSync(portablePath)) return portablePath
  return null
}

function toPosix(p) {
  return p.replace(/\\/g, '/')
}

async function fileSha(filePath) {
  const content = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 40)
}

export async function listRecursiveLocal(baseDir, relDir = '') {
  const fullDir = path.join(baseDir, relDir)
  const entries = await fs.readdir(fullDir, { withFileTypes: true })
  const result = []

  for (const entry of entries) {
    if (entry.name === 'index.json') continue
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const absPath = path.join(baseDir, relPath)
      const stat = await fs.stat(absPath)
      result.push({
        name: entry.name,
        path: toPosix(relPath),
        sha: await fileSha(absPath),
        size: stat.size,
        type: 'file',
      })
    } else if (entry.isDirectory()) {
      const children = await listRecursiveLocal(baseDir, relPath)
      result.push({
        name: entry.name,
        path: toPosix(relPath) + '/',
        type: 'dir',
        children,
      })
    }
  }

  result.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return result
}

export async function readLocalFile(baseDir, filename) {
  const absPath = path.join(baseDir, filename)
  const content = await fs.readFile(absPath, 'utf-8')
  return {
    content,
    sha: await fileSha(absPath),
    name: path.basename(filename),
  }
}

export async function writeLocalFile(baseDir, filename, content) {
  const absPath = path.join(baseDir, filename)
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, content, 'utf-8')
  return fileSha(absPath)
}

export async function deleteLocalFile(baseDir, filename) {
  await fs.unlink(path.join(baseDir, filename))
}

export async function deleteLocalFolder(baseDir, folderPath) {
  await fs.rm(path.join(baseDir, folderPath), { recursive: true, force: true })
}

export async function readLocalIndex(baseDir) {
  const indexPath = path.join(baseDir, 'index.json')
  if (!existsSync(indexPath)) return []
  const raw = await fs.readFile(indexPath, 'utf-8')
  return JSON.parse(raw)
}

export async function writeLocalIndex(baseDir, index) {
  await fs.writeFile(path.join(baseDir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8')
}

export async function renameLocalFile(baseDir, oldPath, newPath) {
  const oldAbs = path.join(baseDir, oldPath)
  const newAbs = path.join(baseDir, newPath)
  await fs.mkdir(path.dirname(newAbs), { recursive: true })
  await fs.rename(oldAbs, newAbs)
}
