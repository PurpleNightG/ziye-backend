import { pool } from '../config/database.js'
import {
  ensureLoginSessionsTable,
  revokeCurrentSession,
  revokeOtherSessions,
  expireStaleSessions,
  getClientIp,
} from './loginSessions.js'
import {
  resolveEffectiveClientIpAsync,
  isLoopbackIp,
  ipsEqual,
} from './clientIp.js'

/**
 * 管理员单点登录：只允许最新未撤销会话；旧会话刷新即失效
 */
export async function assertAdminSingleSession(decoded) {
  if (!decoded?.jti || decoded.userType !== 'admin') {
    return { ok: true }
  }
  await ensureLoginSessionsTable()
  await expireStaleSessions('admin', decoded.id)

  const [actives] = await pool.query(
    `SELECT session_id FROM login_sessions
     WHERE user_type = 'admin' AND user_id = ? AND revoked_at IS NULL
     ORDER BY id DESC`,
    [decoded.id]
  )

  if (actives.length === 0) {
    return { ok: false, code: 'SESSION_GONE', message: '会话已失效，请重新登录' }
  }

  const newest = actives[0].session_id
  if (decoded.jti !== newest) {
    try {
      await revokeCurrentSession('admin', decoded.id, decoded.jti)
    } catch { /* ignore */ }
    return {
      ok: false,
      code: 'SESSION_SUPERSEDED',
      message: '账号已在其它设备登录，当前会话已失效，请重新验证登录',
    }
  }

  if (actives.length > 1) {
    try {
      await revokeOtherSessions('admin', decoded.id, decoded.jti)
    } catch { /* ignore */ }
  }
  return { ok: true }
}

/**
 * 校验管理员会话是否仍绑定登录时的 IP / 设备指纹。
 */
export async function assertAdminSessionBinding(req, decoded) {
  if (!decoded?.jti || decoded.userType !== 'admin') {
    return { ok: true }
  }

  const single = await assertAdminSingleSession(decoded)
  if (!single.ok) return single

  await ensureLoginSessionsTable()
  const [rows] = await pool.query(
    `SELECT id, ip, device_fingerprint, revoked_at, remember_me
     FROM login_sessions WHERE session_id = ? LIMIT 1`,
    [decoded.jti]
  )
  if (!rows.length || rows[0].revoked_at) {
    return { ok: false, code: 'SESSION_GONE', message: '会话已失效，请重新登录' }
  }

  const row = rows[0]
  const rememberMe = Number(row.remember_me) !== 0
  const fp = String(req.headers['x-device-fingerprint'] || '').trim().slice(0, 128)
  const seen = getClientIp(req)
  const onLoopback = isLoopbackIp(seen)
  const claimed = String(req.headers['x-client-public-ip'] || '').trim()
  const hasClaimedPublic = claimed && !isLoopbackIp(claimed)
  const currentIp = await resolveEffectiveClientIpAsync(req)

  // FingerprintJS：用于登录时识别设备 / 异地验证，不在会话期内因漂移或偶发失败踢出
  // （关掉浏览器再开属于正常「记住登录」，指纹偶发变化不应清会话）
  if (fp) {
    if (!row.device_fingerprint) {
      await pool.query(
        `UPDATE login_sessions SET device_fingerprint = ? WHERE id = ? AND device_fingerprint IS NULL`,
        [fp, row.id]
      )
    } else if (fp !== row.device_fingerprint) {
      await pool.query(`UPDATE login_sessions SET device_fingerprint = ? WHERE id = ?`, [
        fp,
        row.id,
      ])
    }
  }

  const sessionIp = row.ip ? String(row.ip).trim() : ''

  if (sessionIp && isLoopbackIp(sessionIp) && currentIp && !isLoopbackIp(currentIp)) {
    await pool.query(`UPDATE login_sessions SET ip = ? WHERE id = ?`, [
      currentIp.slice(0, 45),
      row.id,
    ])
    return { ok: true }
  }

  if (sessionIp && !isLoopbackIp(sessionIp)) {
    if (onLoopback && !hasClaimedPublic && isLoopbackIp(currentIp)) {
      return { ok: true }
    }

    if (onLoopback) {
      if (hasClaimedPublic && !ipsEqual(sessionIp, claimed)) {
        // 本地版常走 127.0.0.1 + 浏览器探测公网 IP；记住登录时只更新绑定，不踢出
        if (rememberMe) {
          await pool.query(`UPDATE login_sessions SET ip = ? WHERE id = ?`, [
            claimed.slice(0, 45),
            row.id,
          ])
          return { ok: true }
        }
        try {
          await revokeCurrentSession('admin', decoded.id, decoded.jti)
        } catch { /* ignore */ }
        return {
          ok: false,
          code: 'SESSION_IP_CHANGED',
          message: '检测到 IP 变化，请重新登录（异地需邮箱验证码）',
        }
      }
      return { ok: true }
    }

    if (!currentIp || isLoopbackIp(currentIp) || !ipsEqual(sessionIp, currentIp)) {
      if (rememberMe && currentIp && !isLoopbackIp(currentIp)) {
        await pool.query(`UPDATE login_sessions SET ip = ? WHERE id = ?`, [
          currentIp.slice(0, 45),
          row.id,
        ])
        return { ok: true }
      }
      if (rememberMe) {
        return { ok: true }
      }
      try {
        await revokeCurrentSession('admin', decoded.id, decoded.jti)
      } catch { /* ignore */ }
      return {
        ok: false,
        code: 'SESSION_IP_CHANGED',
        message: '检测到 IP 变化，请重新登录（异地需邮箱验证码）',
      }
    }
  }

  return { ok: true }
}
