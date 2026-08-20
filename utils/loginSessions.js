import crypto from 'crypto'
import { pool } from '../config/database.js'

/** 每账号最多保留的登录记录条数 */
export const MAX_LOGIN_SESSIONS = 10

/** 勾选「记住登录」时的绝对有效期（与 JWT 7d 对齐） */
export const SESSION_TTL_DAYS = 7

/**
 * 未勾选「记住登录」时：超过该空闲时长无请求，视为已关浏览器/离线 → 已登出。
 * （关浏览器无法可靠通知服务端，只能用「无活动」近似。）
 */
export const EPHEMERAL_IDLE_MINUTES = 15

let loginSessionsTableReady = false
let loginSessionsTablePromise = null

/** 进程内只跑一次建表/补列，避免每个鉴权请求都打 information_schema */
export async function ensureLoginSessionsTable() {
  if (loginSessionsTableReady) return
  if (loginSessionsTablePromise) {
    await loginSessionsTablePromise
    return
  }
  loginSessionsTablePromise = (async () => {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS login_sessions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_type ENUM('admin','student') NOT NULL,
      user_id INT NOT NULL,
      session_id CHAR(36) NOT NULL,
      device_name VARCHAR(160) NULL,
      user_agent VARCHAR(512) NULL,
      ip VARCHAR(45) NULL,
      remember_me TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=记住登录7天 0=临时会话',
      last_active_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      UNIQUE KEY uk_session_id (session_id),
      INDEX idx_ls_user (user_type, user_id),
      INDEX idx_ls_active (user_type, user_id, revoked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='登录设备会话'
  `)

    const [cols] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'login_sessions'
      AND COLUMN_NAME = 'remember_me'
  `)
    if (cols.length === 0) {
      await pool.query(`
      ALTER TABLE login_sessions
        ADD COLUMN remember_me TINYINT(1) NOT NULL DEFAULT 1
          COMMENT '1=记住登录7天 0=临时会话'
          AFTER ip
    `)
    }

    const [fpCols] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'login_sessions'
      AND COLUMN_NAME = 'device_fingerprint'
  `)
    if (fpCols.length === 0) {
      await pool.query(`
      ALTER TABLE login_sessions
        ADD COLUMN device_fingerprint VARCHAR(128) NULL
          COMMENT 'FingerprintJS visitorId'
          AFTER user_agent
    `)
    }
    loginSessionsTableReady = true
  })()
  try {
    await loginSessionsTablePromise
  } finally {
    loginSessionsTablePromise = null
  }
}

/** 同一 session 短时间内复用校验结果，显著减少 identityGate 打库 */
const SESSION_OK_TTL_MS = 45_000
const sessionOkCache = new Map()

function cacheSessionOk(jti) {
  if (!jti) return
  sessionOkCache.set(jti, Date.now() + SESSION_OK_TTL_MS)
  if (sessionOkCache.size > 5000) {
    const now = Date.now()
    for (const [k, exp] of sessionOkCache) {
      if (exp <= now) sessionOkCache.delete(k)
    }
  }
}

export function invalidateSessionCache(jti) {
  if (jti) sessionOkCache.delete(jti)
}

export function invalidateUserSessionCache(_userType, _userId) {
  // jti 未知时清空（踢全员 / 删号），量级可控
  sessionOkCache.clear()
}

/** 同一会话活跃写入节流（空闲阈值 15 分钟，90s 写一次足够） */
const TOUCH_MIN_INTERVAL_MS = 90_000
const lastTouchAt = new Map()

export function getClientIp(req) {
  // 仅在显式信任反向代理时读取 X-Forwarded-For，避免客户端伪造 IP 绕过限流/异地校验
  const trustProxy =
    process.env.TRUST_PROXY === '1' ||
    process.env.TRUST_PROXY === 'true' ||
    process.env.TRUST_PROXY === 'yes'
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    if (typeof fwd === 'string' && fwd.trim()) {
      return fwd.split(',')[0].trim().slice(0, 45)
    }
  }
  return (req.ip || req.socket?.remoteAddress || '').slice(0, 45) || null
}

/** 从 UA 粗分设备名 */
export function parseDeviceName(ua = '') {
  const s = String(ua || '')
  let os = '未知系统'
  if (/Windows NT/i.test(s)) os = 'Windows'
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS'
  else if (/Android/i.test(s)) os = 'Android'
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS'
  else if (/Linux/i.test(s)) os = 'Linux'

  let browser = '浏览器'
  if (/Edg\//i.test(s)) browser = 'Edge'
  else if (/Chrome\//i.test(s) && !/Edg\//i.test(s)) browser = 'Chrome'
  else if (/Firefox\//i.test(s)) browser = 'Firefox'
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = 'Safari'

  return `${browser} · ${os}`.slice(0, 160)
}

function ttlDays() {
  return Number(SESSION_TTL_DAYS) || 7
}

function idleMinutes() {
  return Number(EPHEMERAL_IDLE_MINUTES) || 15
}

function isCreatedExpired(createdAt) {
  if (!createdAt) return false
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  return Date.now() - t >= ttlDays() * 24 * 60 * 60 * 1000
}

function isEphemeralIdle(rememberMe, lastActiveAt, createdAt) {
  if (Number(rememberMe) !== 0) return false
  const base = lastActiveAt || createdAt
  if (!base) return false
  const t = new Date(base).getTime()
  if (Number.isNaN(t)) return false
  return Date.now() - t >= idleMinutes() * 60 * 1000
}

/**
 * 清理失效会话：
 * 1) 任意会话超过 7 天绝对期限
 * 2) 未记住登录的会话空闲超过 EPHEMERAL_IDLE_MINUTES（近似关浏览器）
 */
export async function expireStaleSessions(userType, userId) {
  await ensureLoginSessionsTable()
  const days = ttlDays()
  const idle = idleMinutes()
  const userFilter =
    userType != null && userId != null ? 'AND user_type = ? AND user_id = ?' : ''
  const userParams = userType != null && userId != null ? [userType, userId] : []

  await pool.query(
    `UPDATE login_sessions
     SET revoked_at = DATE_ADD(created_at, INTERVAL ${days} DAY)
     WHERE revoked_at IS NULL
       AND created_at < DATE_SUB(NOW(), INTERVAL ${days} DAY)
       ${userFilter}`,
    userParams
  )

  await pool.query(
    `UPDATE login_sessions
     SET revoked_at = COALESCE(last_active_at, created_at)
     WHERE revoked_at IS NULL
       AND remember_me = 0
       AND COALESCE(last_active_at, created_at) < DATE_SUB(NOW(), INTERVAL ${idle} MINUTE)
       ${userFilter}`,
    userParams
  )
}

/** 超出上限时删除最旧记录（优先保留未登出） */
export async function trimSessions(userType, userId, keep = MAX_LOGIN_SESSIONS) {
  await ensureLoginSessionsTable()
  await pool.query(
    `DELETE FROM login_sessions
     WHERE user_type = ? AND user_id = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM login_sessions
           WHERE user_type = ? AND user_id = ?
           ORDER BY (revoked_at IS NULL) DESC,
                    COALESCE(last_active_at, created_at) DESC
           LIMIT ?
         ) AS keep_rows
       )`,
    [userType, userId, userType, userId, keep]
  )
}

export async function createLoginSession(req, { userType, userId, deviceName, rememberMe = true, ipOverride = null, deviceFingerprint = null }) {
  await ensureLoginSessionsTable()
  await expireStaleSessions(userType, userId)
  const sessionId = crypto.randomUUID()
  const ua = String(req.headers['user-agent'] || '').slice(0, 512)
  const ip = (ipOverride && String(ipOverride).slice(0, 45)) || getClientIp(req)
  const name = (deviceName && String(deviceName).trim().slice(0, 160)) || parseDeviceName(ua)
  const remember = rememberMe ? 1 : 0
  const fp =
    (deviceFingerprint && String(deviceFingerprint).trim().slice(0, 128)) ||
    String(req.headers['x-device-fingerprint'] || '').trim().slice(0, 128) ||
    null
  await pool.query(
    `INSERT INTO login_sessions
       (user_type, user_id, session_id, device_name, user_agent, device_fingerprint, ip, remember_me, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [userType, userId, sessionId, name, ua || null, fp || null, ip, remember]
  )
  await trimSessions(userType, userId)
  return sessionId
}

export async function touchSession(sessionId) {
  if (!sessionId) return
  const now = Date.now()
  const prev = lastTouchAt.get(sessionId) || 0
  if (now - prev < TOUCH_MIN_INTERVAL_MS) return
  lastTouchAt.set(sessionId, now)
  if (lastTouchAt.size > 5000) {
    for (const [k, t] of lastTouchAt) {
      if (now - t > TOUCH_MIN_INTERVAL_MS * 2) lastTouchAt.delete(k)
    }
  }
  try {
    const days = ttlDays()
    const idle = idleMinutes()
    await pool.query(
      `UPDATE login_sessions
       SET last_active_at = NOW()
       WHERE session_id = ?
         AND revoked_at IS NULL
         AND created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
         AND (
           remember_me = 1
           OR COALESCE(last_active_at, created_at) >= DATE_SUB(NOW(), INTERVAL ${idle} MINUTE)
         )`,
      [sessionId]
    )
  } catch {
    /* ignore */
  }
}

/** 校验会话未撤销且未过期；管理员必须有 jti；无 jti 的旧学员 token 仍放行至自然过期 */
export async function assertSessionActive(decoded) {
  if (!decoded?.jti) {
    if (decoded?.userType === 'admin') return false
    return true
  }
  const cachedUntil = sessionOkCache.get(decoded.jti)
  if (cachedUntil && cachedUntil > Date.now()) {
    return true
  }
  await ensureLoginSessionsTable()
  const [rows] = await pool.query(
    `SELECT id, created_at, revoked_at, remember_me, last_active_at
     FROM login_sessions WHERE session_id = ? LIMIT 1`,
    [decoded.jti]
  )
  if (!rows.length) return false
  const row = rows[0]
  if (row.revoked_at) return false
  if (isCreatedExpired(row.created_at)) return false
  if (isEphemeralIdle(row.remember_me, row.last_active_at, row.created_at)) return false

  cacheSessionOk(decoded.jti)
  return true
}

export async function listSessions(userType, userId, currentJti) {
  await ensureLoginSessionsTable()
  await expireStaleSessions(userType, userId)
  const [rows] = await pool.query(
    `SELECT id, session_id, device_name, user_agent, ip, remember_me,
            last_active_at, created_at, revoked_at
     FROM login_sessions
     WHERE user_type = ? AND user_id = ?
     ORDER BY (revoked_at IS NULL) DESC, COALESCE(last_active_at, created_at) DESC
     LIMIT ?`,
    [userType, userId, MAX_LOGIN_SESSIONS]
  )
  return rows.map((r) => {
    const idleOut = isEphemeralIdle(r.remember_me, r.last_active_at, r.created_at)
    const expired = !r.revoked_at && (isCreatedExpired(r.created_at) || idleOut)
    const revoked = !!(r.revoked_at || expired)
    return {
      id: r.id,
      session_id: r.session_id,
      device_name: r.device_name || '未知设备',
      ip: r.ip,
      remember_me: !!Number(r.remember_me),
      last_active_at: r.last_active_at,
      created_at: r.created_at,
      revoked,
      expired,
      is_current: !!(currentJti && r.session_id === currentJti && !revoked),
    }
  })
}

/**
 * 登出设备：标记 revoked，保留记录（不等于删除）
 */
export async function revokeSession(userType, userId, sessionRowId, currentJti) {
  await ensureLoginSessionsTable()
  await expireStaleSessions(userType, userId)
  const [rows] = await pool.query(
    `SELECT id, session_id, revoked_at FROM login_sessions
     WHERE id = ? AND user_type = ? AND user_id = ? LIMIT 1`,
    [sessionRowId, userType, userId]
  )
  if (!rows.length) return { ok: false, reason: 'not_found' }
  if (currentJti && rows[0].session_id === currentJti) {
    return { ok: false, reason: 'current' }
  }
  if (rows[0].revoked_at) {
    return { ok: false, reason: 'already' }
  }
  await pool.query(
    `UPDATE login_sessions SET revoked_at = NOW()
     WHERE id = ? AND user_type = ? AND user_id = ? AND revoked_at IS NULL`,
    [sessionRowId, userType, userId]
  )
  invalidateSessionCache(rows[0].session_id)
  return { ok: true }
}

/** 登出当前设备（按 JWT jti 标记撤销） */
export async function revokeCurrentSession(userType, userId, jti) {
  await ensureLoginSessionsTable()
  if (!jti) return { ok: false, reason: 'no_jti' }
  const [result] = await pool.query(
    `UPDATE login_sessions
     SET revoked_at = NOW()
     WHERE user_type = ? AND user_id = ? AND session_id = ? AND revoked_at IS NULL`,
    [userType, userId, jti]
  )
  if (result.affectedRows === 0) {
    const [rows] = await pool.query(
      `SELECT id, revoked_at FROM login_sessions
       WHERE user_type = ? AND user_id = ? AND session_id = ? LIMIT 1`,
      [userType, userId, jti]
    )
    if (!rows.length) return { ok: false, reason: 'not_found' }
    if (rows[0].revoked_at) return { ok: true, reason: 'already' }
    return { ok: false, reason: 'not_found' }
  }
  invalidateSessionCache(jti)
  return { ok: true }
}

/**
 * 删除登录记录：仅从库中移除，不负责「登出」语义。
 * 若记录仍在线，不允许直接删（请先登出）；已失效的可删。
 */
export async function deleteSession(userType, userId, sessionRowId, currentJti) {
  await ensureLoginSessionsTable()
  await expireStaleSessions(userType, userId)
  const [rows] = await pool.query(
    `SELECT id, session_id, revoked_at, created_at, remember_me, last_active_at
     FROM login_sessions
     WHERE id = ? AND user_type = ? AND user_id = ? LIMIT 1`,
    [sessionRowId, userType, userId]
  )
  if (!rows.length) return { ok: false, reason: 'not_found' }
  if (currentJti && rows[0].session_id === currentJti) {
    return { ok: false, reason: 'current' }
  }
  const stillActive =
    !rows[0].revoked_at &&
    !isCreatedExpired(rows[0].created_at) &&
    !isEphemeralIdle(rows[0].remember_me, rows[0].last_active_at, rows[0].created_at)
  if (stillActive) {
    return { ok: false, reason: 'still_active' }
  }
  await pool.query(`DELETE FROM login_sessions WHERE id = ? AND user_type = ? AND user_id = ?`, [
    sessionRowId,
    userType,
    userId,
  ])
  return { ok: true }
}

/** 登出其它设备：只标记撤销，保留记录 */
export async function revokeOtherSessions(userType, userId, currentJti) {
  await ensureLoginSessionsTable()
  await expireStaleSessions(userType, userId)
  invalidateUserSessionCache(userType, userId)
  if (currentJti) {
    // 当前会话仍有效，重新写入短缓存
    cacheSessionOk(currentJti)
    const [result] = await pool.query(
      `UPDATE login_sessions
       SET revoked_at = NOW()
       WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL AND session_id != ?`,
      [userType, userId, currentJti]
    )
    return result.affectedRows
  }
  const [result] = await pool.query(
    `UPDATE login_sessions
     SET revoked_at = NOW()
     WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL`,
    [userType, userId]
  )
  return result.affectedRows
}

export async function revokeAllSessions(userType, userId) {
  await ensureLoginSessionsTable()
  invalidateUserSessionCache(userType, userId)
  const [result] = await pool.query(
    `UPDATE login_sessions
     SET revoked_at = NOW()
     WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL`,
    [userType, userId]
  )
  return result.affectedRows
}
