import express from 'express'
import multer from 'multer'
import FormData from 'form-data'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const router = express.Router()
const API_KEY = '64951e50eb42feec6bbe9c17197aa62c'
const UPLOAD_URL = `http://up.abyss.to/${API_KEY}`
const API_BASE_URL = 'https://api.abyss.to/v1'

// 确保 uploads 目录存在
const uploadDir = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// 配置 multer 用于临时存储上传的文件
const upload = multer({ dest: uploadDir })

// 上传视频到 Abyss.to
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '未选择文件' })
    }

    const formData = new FormData()
    const fileStream = fs.createReadStream(req.file.path)
    
    // 使用简单的文件名，避免编码问题
    const safeFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
    
    formData.append('file', fileStream, {
      filename: safeFilename,
      contentType: req.file.mimetype
    })

    const response = await fetch(UPLOAD_URL, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders()
    })

    const text = await response.text()
    
    // 删除临时文件
    fs.unlinkSync(req.file.path)

    if (!response.ok) {
      return res.status(response.status).json({ 
        success: false, 
        message: `Abyss.to API 错误 (${response.status}): ${text || '无响应内容'}` 
      })
    }

    // 解析 JSON
    let result
    try {
      result = JSON.parse(text)
    } catch (e) {
      return res.status(500).json({ success: false, message: 'API返回格式错误: ' + text })
    }

    // Abyss.to 返回 {"slug": "file-id"}
    if (result.slug) {
      res.json({ 
        success: true, 
        data: {
          slug: result.slug,
          embed_url: `https://abyss.to/${result.slug}`,
          status: 'waiting'
        }
      })
    } else {
      res.status(400).json({ success: false, message: result.message || '上传失败' })
    }
  } catch (error) {
    // 清理临时文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    res.status(500).json({ success: false, message: '上传视频失败: ' + error.message })
  }
})

// 从 Google Drive 导入视频
router.post('/import-drive', async (req, res) => {
  try {
    const { driveId } = req.body

    if (!driveId) {
      return res.status(400).json({ success: false, message: '请提供 Google Drive ID' })
    }

    const response = await fetch(`${API_BASE_URL}/remote/${driveId}?key=${API_KEY}`, {
      method: 'POST'
    })

    const text = await response.text()
    const result = JSON.parse(text)

    // Abyss.to 返回文件信息，包含 id 字段
    if (result.id) {
      res.json({ 
        success: true, 
        data: {
          slug: result.id,
          embed_url: `https://abyss.to/${result.id}`,
          status: result.status || 'waiting'
        }
      })
    } else {
      res.status(400).json({ success: false, message: result.message || '导入失败' })
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '导入视频失败: ' + error.message })
  }
})

// 获取资源列表（文件和文件夹）
router.get('/list', async (req, res) => {
  try {
    const page = req.query.page || 1
    const pageToken = req.query.pageToken || ''
    const folderId = req.query.folderId || ''
    
    let url = `${API_BASE_URL}/resources?key=${API_KEY}&maxResults=25&orderBy=createdAt:desc`
    if (pageToken) {
      url += `&pageToken=${pageToken}`
    }
    if (folderId) {
      url += `&folderId=${folderId}`
    }
    
    const response = await fetch(url)
    
    if (!response.ok) {
      const errorText = await response.text()
      return res.status(400).json({ 
        success: false, 
        message: `API 错误 (${response.status}): ${errorText || response.statusText}` 
      })
    }

    const text = await response.text()
    const result = JSON.parse(text)

    // Abyss.to 返回 { items: [...], pageToken: "...", name: "...", breadcrumbs: [...] }
    if (result.items) {
      // 转换为前端需要的格式，区分文件夹和文件
      const formattedItems = result.items.map(item => {
        if (item.isDir) {
          // 文件夹
          return {
            isDir: true,
            id: item.id,
            name: item.name,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          }
        } else {
          // 文件
          return {
            isDir: false,
            name: item.name,
            size: item.size,
            resolution: item.resolutions ? item.resolutions.join(',') : 'Unknown',
            status: item.status,
            slug: item.id,
            embed_url: `https://abyss.to/${item.id}`,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          }
        }
      })
      
      res.json({ 
        success: true, 
        data: {
          name: result.name || 'Root',
          breadcrumbs: result.breadcrumbs || [],
          items: formattedItems,
          pagination: {
            current: page,
            next: result.pageToken ? parseInt(page) + 1 : parseInt(page)
          },
          pageToken: result.pageToken
        }
      })
    } else {
      res.status(400).json({ success: false, message: '返回数据格式错误' })
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '获取视频列表失败: ' + error.message })
  }
})

// 获取视频状态
router.get('/status/:slug', async (req, res) => {
  try {
    const { slug } = req.params
    const response = await fetch(`${API_BASE_URL}/files/${slug}?key=${API_KEY}`)
    const text = await response.text()
    const result = JSON.parse(text)

    if (result.id) {
      res.json({ 
        success: true, 
        data: {
          status: result.status,
          resolution: result.resolutions ? result.resolutions.join(',') : 'Unknown'
        }
      })
    } else {
      res.status(400).json({ success: false, message: result.message || '获取状态失败' })
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '获取视频状态失败: ' + error.message })
  }
})

// 复制视频（Abyss.to 不支持此功能，返回提示）
router.post('/copy/:slug', async (req, res) => {
  res.status(501).json({ 
    success: false, 
    message: 'Abyss.to API 不支持复制视频功能' 
  })
})

// 删除视频
router.delete('/delete/:slug', async (req, res) => {
  try {
    const { slug } = req.params
    
    const response = await fetch(`${API_BASE_URL}/files/${slug}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    })

    if (response.ok || response.status === 204) {
      res.json({ success: true })
    } else {
      const text = await response.text()
      res.status(400).json({ success: false, message: '删除失败: ' + text })
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '删除视频失败: ' + error.message })
  }
})

// 添加字幕（需要文件上传，暂不实现）
router.post('/subtitle/:slug', async (req, res) => {
  res.status(501).json({ 
    success: false, 
    message: 'Abyss.to 字幕上传需要文件，暂未实现' 
  })
})

export default router
