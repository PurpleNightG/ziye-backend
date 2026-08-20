import express from 'express'
import crypto from 'crypto'

const router = express.Router()

// Reverse-engineered from official console-generated token
// Format: "001" + appId (plain text) + base64( packUint16(msgLen) + msg + packUint16(sigLen) + sig )
// Message (signed): nonce(u32) + issuedAt(u32) + expiredAt(u32) + packStr(roomId) + packStr(userId) + privileges(6 keys)
// HMAC-SHA256 key = appKey as raw UTF-8 string
function buildVolcToken(appId, appKey, roomId, userId, expireSeconds = 7200) {
  const now = Math.floor(Date.now() / 1000)
  const expiredAt = now + expireSeconds
  const nonce = crypto.randomBytes(4).readUInt32LE(0)

  function packUint16(n) {
    const b = Buffer.allocUnsafe(2)
    b.writeUInt16LE(n, 0)
    return b
  }
  function packUint32(n) {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32LE(n >>> 0, 0)
    return b
  }
  function packString(s) {
    const sb = Buffer.from(s, 'utf8')
    return Buffer.concat([packUint16(sb.length), sb])
  }

  // 6 privileges (keys 0-5), all with expiredAt as value
  const privBufs = [packUint16(6)]
  for (let k = 0; k < 6; k++) {
    privBufs.push(packUint16(k))
    privBufs.push(packUint32(expiredAt))
  }

  // Message to sign (appId is NOT included - it goes in the plain text prefix)
  const msg = Buffer.concat([
    packUint32(nonce),
    packUint32(now),
    packUint32(expiredAt),
    packString(roomId),
    packString(userId),
    ...privBufs,
  ])

  const sig = crypto.createHmac('sha256', appKey).update(msg).digest()

  // Final: "001" + appId + base64( packUint16(msg.length) + msg + packUint16(sig.length) + sig )
  const payload = Buffer.concat([packUint16(msg.length), msg, packUint16(sig.length), sig])
  return '001' + appId + payload.toString('base64')
}

router.post('/token', (req, res) => {
  // No-token test: set VOLC_NO_TOKEN=true in .env → SDK will use Basic auth (no real token)
  if (process.env.VOLC_NO_TOKEN === 'true') {
    return res.json({ success: true, token: null })
  }
  // Temp token passthrough for debugging - set VOLC_TEMP_TOKEN in .env to bypass generation
  if (process.env.VOLC_TEMP_TOKEN) {
    return res.json({ success: true, token: process.env.VOLC_TEMP_TOKEN })
  }

  const appId = process.env.VOLC_APP_ID
  const appKey = process.env.VOLC_APP_KEY

  if (!appId || !appKey) {
    return res.status(500).json({ success: false, error: 'Volcengine credentials not configured' })
  }

  const { roomId, userId } = req.body
  if (!roomId || !userId) {
    return res.status(400).json({ success: false, error: 'roomId and userId are required' })
  }

  const token = buildVolcToken(appId, appKey, roomId, userId)
  console.log('[Volc] Generated token for', userId)
  res.json({ success: true, token })
})

// Debug: decode a token to inspect binary structure
router.post('/decode', (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'token required' })

  try {
    const buf = Buffer.from(token, 'base64')
    const result = { byteLength: buf.length, hex: buf.toString('hex'), fields: {} }

    let pos = 0
    const readStr = () => {
      if (pos + 2 > buf.length) return null
      const len = buf.readUInt16LE(pos); pos += 2
      if (pos + len > buf.length) return null
      const s = buf.toString('utf8', pos, pos + len); pos += len
      return s
    }
    const readStrBE = () => {
      if (pos + 2 > buf.length) return null
      const len = buf.readUInt16BE(pos); pos += 2
      if (pos + len > buf.length) return null
      const s = buf.toString('utf8', pos, pos + len); pos += len
      return s
    }

    result.fields.version_utf8 = buf.toString('utf8', 0, 3)
    result.fields.version_hex = buf.slice(0, 3).toString('hex')
    result.fields.byte3_LE = buf.readUInt16LE(3)
    result.fields.byte3_BE = buf.readUInt16BE(3)
    result.fields.byteAfterVersion_raw = buf.slice(3, 10).toString('hex')
    result.fields.signatureBytes = buf.slice(buf.length - 32).toString('hex')

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
