import express from 'express'
import fetch from 'node-fetch'

const router = express.Router()

const UPSTREAM = (process.env.ZIYE_UPSTREAM_URL || 'http://160.202.254.36:10116').replace(/\/$/, '')

router.all('*', async (req, res) => {
  const path = req.url || '/'
  const url = `${UPSTREAM}${path}`
  try {
    const headers = { Host: new URL(UPSTREAM).host }
    const ct = req.get('content-type')
    if (ct) headers['Content-Type'] = ct

    const init = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(15000),
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body?.length) {
      init.body = req.body
    }

    const upstream = await fetch(url, init)
    const text = await upstream.text()

    res.status(upstream.status)
    const respCt = upstream.headers.get('content-type')
    if (respCt) res.setHeader('Content-Type', respCt)
    res.send(text)
  } catch (err) {
    const code = err.code || err.cause?.code
    const hint = code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND'
      ? `无法连接 ${UPSTREAM}，请确认 NAT 已映射 10116 且安全组已放行`
      : err.message
    console.error('[ZiyeProxy]', url, hint)
    res.status(502).type('text/plain').send(`紫夜流媒体代理失败: ${hint}`)
  }
})

export default router
