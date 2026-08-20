import express from 'express'

const router = express.Router()

const GITEE_VERSION_URL = 'https://gitee.com/NDYian/mod-manager/raw/master/version.json'

// 代理获取 Gitee 上的 version.json（解决前端跨域问题）
router.get('/latest', async (req, res) => {
  try {
    const response = await fetch(GITEE_VERSION_URL)
    if (!response.ok) throw new Error(`Gitee responded ${response.status}`)
    const data = await response.json()
    res.json(data)
  } catch (error) {
    console.error('获取版本信息失败:', error)
    res.status(500).json({ version: null, error: '获取版本信息失败' })
  }
})

export default router
