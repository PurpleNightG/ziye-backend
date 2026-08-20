import express from 'express'

const router = express.Router()

// 生成 Cloudflare TURN 临时凭证
router.post('/credentials', async (req, res) => {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN

  if (!keyId || !apiToken) {
    return res.status(500).json({ success: false, message: 'TURN 服务未配置' })
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      console.error('Cloudflare TURN API error:', response.status, text)
      return res.status(502).json({ success: false, message: 'TURN 凭证获取失败' })
    }

    const data = await response.json()
    res.json({ success: true, iceServers: data.iceServers })
  } catch (err) {
    console.error('TURN credentials error:', err)
    res.status(500).json({ success: false, message: '服务器内部错误' })
  }
})

export default router
