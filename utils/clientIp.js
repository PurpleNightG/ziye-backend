import { getClientIp } from './loginSessions.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

let egressCache = { ip: null, at: 0 }
let egressInflight = null

export function isLoopbackIp(ip) {
  if (!ip) return true
  const s = String(ip).trim().toLowerCase()
  if (LOOPBACK.has(s)) return true
  if (s.startsWith('127.')) return true
  return false
}

export function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase()
  if (s.startsWith('::ffff:')) s = s.slice(7)
  return s
}

export function ipsEqual(a, b) {
  return normalizeIp(a) === normalizeIp(b)
}

function pickIp(text) {
  const m = String(text || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)
  return m?.[1] || null
}

/** 本机出口公网 IP（服务端探测，供本地环回请求绑定用） */
export async function getServerEgressIp() {
  const now = Date.now()
  if (egressCache.ip && now - egressCache.at < 30 * 60 * 1000) {
    return egressCache.ip
  }
  if (egressInflight) return egressInflight

  egressInflight = (async () => {
    const urls = [
      'https://ipv4.icanhazip.com',
      'https://ifconfig.me/ip',
      'https://api64.ipify.org?format=json',
    ]
    for (const url of urls) {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 2500)
        const r = await fetch(url, { signal: ctrl.signal })
        clearTimeout(t)
        if (!r.ok) continue
        const raw = await r.text()
        let ip = null
        if (url.includes('ipify')) {
          try {
            ip = pickIp(JSON.parse(raw)?.ip)
          } catch {
            ip = pickIp(raw)
          }
        } else {
          ip = pickIp(raw)
        }
        if (ip && !isLoopbackIp(ip)) {
          egressCache = { ip, at: Date.now() }
          return ip
        }
      } catch {
        /* try next */
      }
    }
    return egressCache.ip
  })()

  try {
    return await egressInflight
  } finally {
    egressInflight = null
  }
}

/**
 * 解析有效客户端 IP：
 * - 线上：以服务器看到的真实 IP 为准（忽略客户端伪造）
 * - 本地环回：header / body 公网 IP → 再尝试服务端出口 IP
 */
export function resolveEffectiveClientIp(req, bodyPublicIp) {
  const seen = getClientIp(req)
  if (!isLoopbackIp(seen)) {
    return String(seen).slice(0, 45)
  }
  const fromHeader = req?.headers?.['x-client-public-ip']
  const claimed = String(bodyPublicIp || fromHeader || '').trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(claimed) || (claimed.includes(':') && !isLoopbackIp(claimed))) {
    if (!isLoopbackIp(claimed)) return claimed.slice(0, 45)
  }
  return seen || '127.0.0.1'
}

/** async 版：环回时补服务端出口 IP */
export async function resolveEffectiveClientIpAsync(req, bodyPublicIp) {
  const sync = resolveEffectiveClientIp(req, bodyPublicIp)
  if (!isLoopbackIp(sync)) return sync
  const egress = await getServerEgressIp()
  if (egress && !isLoopbackIp(egress)) return egress.slice(0, 45)
  return sync
}

/**
 * 是否视为异地：与该管理员历史成功登录 IP（非环回）集合比较
 * 无历史记录 → 不算异地（首次）
 */
export async function isRemoteLoginIp(adminId, currentIp) {
  if (!currentIp || isLoopbackIp(currentIp)) {
    return false
  }
  const { pool } = await import('../config/database.js')
  // 不用 DISTINCT + ORDER BY id（MySQL ONLY_FULL_GROUP_BY 会报错）
  const [rows] = await pool.query(
    `SELECT ip FROM login_sessions
     WHERE user_type = 'admin' AND user_id = ?
       AND ip IS NOT NULL AND ip != ''
     ORDER BY id DESC
     LIMIT 80`,
    [adminId]
  )
  const trusted = new Set()
  for (const r of rows) {
    const ip = String(r.ip || '').trim()
    if (ip && !isLoopbackIp(ip)) trusted.add(normalizeIp(ip))
  }
  if (trusted.size === 0) return false
  return !trusted.has(normalizeIp(currentIp))
}

/**
 * 是否视为新设备：与「最近一次」成功登录的指纹不同即触发
 * （同网换 Chrome/Edge 也会触发；同一浏览器重复登录不触发）
 * 无历史指纹 / 本次未采集 → 不算
 */
export async function isRemoteLoginDevice(adminId, fingerprint) {
  const fp = String(fingerprint || '').trim()
  if (!fp) return false
  const { pool } = await import('../config/database.js')
  const [rows] = await pool.query(
    `SELECT device_fingerprint FROM login_sessions
     WHERE user_type = 'admin' AND user_id = ?
       AND device_fingerprint IS NOT NULL AND device_fingerprint != ''
     ORDER BY id DESC
     LIMIT 1`,
    [adminId]
  )
  if (!rows.length) return false
  const last = String(rows[0].device_fingerprint || '').trim()
  if (!last) return false
  return last !== fp
}

/**
 * 浏览器族变化（Chrome ↔ Edge 等）作为指纹补充信号
 */
export function browserFamily(ua = '') {
  const s = String(ua || '')
  if (/Edg\//i.test(s)) return 'edge'
  if (/Chrome\//i.test(s) && !/Edg\//i.test(s)) return 'chrome'
  if (/Firefox\//i.test(s)) return 'firefox'
  if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) return 'safari'
  return 'other'
}

export async function isRemoteLoginBrowser(adminId, userAgent) {
  const family = browserFamily(userAgent)
  if (!family || family === 'other') return false
  const { pool } = await import('../config/database.js')
  const [rows] = await pool.query(
    `SELECT user_agent FROM login_sessions
     WHERE user_type = 'admin' AND user_id = ?
       AND user_agent IS NOT NULL AND user_agent != ''
     ORDER BY id DESC
     LIMIT 1`,
    [adminId]
  )
  if (!rows.length) return false
  const lastFamily = browserFamily(rows[0].user_agent)
  if (!lastFamily || lastFamily === 'other') return false
  return lastFamily !== family
}

/**
 * IP / 设备 / 浏览器变化、首次登录、或已有活跃会话（单点）→ 邮箱二次验证
 */
export async function evaluateRemoteLogin(adminId, currentIp, fingerprint, userAgent) {
  const reasons = []
  if (await isFirstAdminLogin(adminId)) {
    reasons.push('first')
    return { remote: true, reasons }
  }
  if (await countActiveAdminSessions(adminId) >= 1) {
    reasons.push('concurrent')
  }
  if (await isRemoteLoginIp(adminId, currentIp)) reasons.push('ip')
  if (await isRemoteLoginDevice(adminId, fingerprint)) reasons.push('device')
  else if (await isRemoteLoginBrowser(adminId, userAgent)) reasons.push('browser')
  return { remote: reasons.length > 0, reasons }
}

/** 该管理员是否从未成功登录过（无会话记录） */
export async function isFirstAdminLogin(adminId) {
  const { pool } = await import('../config/database.js')
  const [rows] = await pool.query(
    `SELECT id FROM login_sessions
     WHERE user_type = 'admin' AND user_id = ?
     LIMIT 1`,
    [adminId]
  )
  return rows.length === 0
}

/** 当前未撤销的活跃登录数（管理员单点：最多 1 个） */
export async function countActiveAdminSessions(adminId) {
  const { expireStaleSessions } = await import('./loginSessions.js')
  const { pool } = await import('../config/database.js')
  await expireStaleSessions('admin', adminId)
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS c FROM login_sessions
     WHERE user_type = 'admin' AND user_id = ? AND revoked_at IS NULL`,
    [adminId]
  )
  return Number(row?.c || 0)
}
