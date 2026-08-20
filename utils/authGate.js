import jwt from 'jsonwebtoken'
import { pool } from '../config/database.js'
import {
  assertSessionActive,
  touchSession,
  revokeAllSessions,
  getClientIp,
} from './loginSessions.js'
import { hasBoundEmail, ensureAdminRoleColumns, assertAdminLoginAllowed } from './adminRoles.js'
import { assertAdminSessionBinding } from './sessionBinding.js'

const JWT_SECRET = () => process.env.JWT_SECRET || 'your-secret-key'

/** 解析 Bearer token；无效返回 null */
export function extractBearer(req) {
  const raw = req.headers.authorization
  if (!raw || typeof raw !== 'string') return null
  const m = raw.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

export function resolveUserType(decoded) {
  if (!decoded) return null
  if (decoded.role === 'student' || decoded.userType === 'student') return 'student'
  if (decoded.userType === 'admin') return 'admin'
  return null
}

/**
 * 账号是否仍存在（库中删掉管理员后必须立刻失效）
 * students 表为旧名；学员以 members 为准
 */
export async function assertIdentityValid(decoded) {
  if (!decoded?.id) return false
  const userType = resolveUserType(decoded)
  try {
    if (userType === 'admin') {
      const [rows] = await pool.query('SELECT id FROM admins WHERE id = ? LIMIT 1', [decoded.id])
      return rows.length > 0
    }
    if (userType === 'student') {
      const [rows] = await pool.query(
        'SELECT id FROM members WHERE id = ? LIMIT 1',
        [decoded.id]
      )
      return rows.length > 0
    }
  } catch (e) {
    console.error('[authGate] assertIdentityValid', e.message)
    return false
  }
  return false
}

/** 管理员必须已绑定安全邮箱；未绑定则已有会话也立刻作废 */
export async function assertAdminEmailBound(adminId) {
  try {
    await ensureAdminRoleColumns()
    const [rows] = await pool.query('SELECT email FROM admins WHERE id = ? LIMIT 1', [adminId])
    if (!rows.length) return false
    return hasBoundEmail(rows[0].email)
  } catch (e) {
    console.error('[authGate] assertAdminEmailBound', e.message)
    return false
  }
}

/**
 * 完整校验：JWT + 会话未撤销 + 账号仍存在 +（管理员须绑邮箱）
 * @returns {{ decoded, userType, userId, jti } | null}
 */
export async function authenticateRequest(req, { requireType = null } = {}) {
  const token = extractBearer(req)
  if (!token) return null

  let decoded
  try {
    decoded = jwt.verify(token, JWT_SECRET())
  } catch {
    return null
  }

  const userType = resolveUserType(decoded)
  if (!userType) return null
  if (requireType && userType !== requireType) return null

  const active = await assertSessionActive(decoded)
  if (!active) return null

  const exists = await assertIdentityValid(decoded)
  if (!exists) {
    try {
      await revokeAllSessions(userType, decoded.id)
    } catch {
      /* ignore */
    }
    return null
  }

  if (userType === 'admin') {
    const emailOk = await assertAdminEmailBound(decoded.id)
    if (!emailOk) {
      try {
        await revokeAllSessions('admin', decoded.id)
      } catch {
        /* ignore */
      }
      return null
    }

    const loginOk = await assertAdminLoginAllowed(decoded.id)
    if (!loginOk.ok) {
      try {
        await revokeAllSessions('admin', decoded.id)
      } catch {
        /* ignore */
      }
      return null
    }

    const bind = await assertAdminSessionBinding(req, decoded)
    if (!bind.ok) {
      return null
    }
  }

  void touchSession(decoded.jti)
  return {
    decoded,
    userType,
    userId: decoded.id,
    jti: decoded.jti || null,
    username: decoded.username || null,
  }
}

/** Express：任意已登录用户 */
export function requireAuth(req, res, next) {
  authenticateRequest(req)
    .then((auth) => {
      if (!auth) {
        return res.status(401).json({ success: false, message: '未登录或会话已失效，请重新登录' })
      }
      req.auth = auth
      req.user = auth.decoded
      next()
    })
    .catch((e) => {
      console.error('[requireAuth]', e)
      res.status(500).json({ success: false, message: '认证失败' })
    })
}

/** Express：仅管理员 */
export function requireAdmin(req, res, next) {
  authenticateRequest(req, { requireType: 'admin' })
    .then(async (auth) => {
      if (!auth) {
        // 区分绑定失败需要更明确信息：再查一次（token 仍可能有效）
        const token = extractBearer(req)
        if (token) {
          try {
            const decoded = jwt.verify(token, JWT_SECRET())
            if (resolveUserType(decoded) === 'admin') {
              const bind = await assertAdminSessionBinding(req, decoded)
              if (!bind.ok) {
                return res.status(401).json({
                  success: false,
                  message: bind.message || '会话已失效，请重新登录',
                  code: bind.code || 'SESSION_BINDING',
                })
              }
              if (!(await assertAdminEmailBound(decoded.id))) {
                return res.status(401).json({
                  success: false,
                  message: '该管理员未绑定安全邮箱，请联系超级管理员绑定后再登录',
                  code: 'EMAIL_REQUIRED',
                })
              }
              const loginOk = await assertAdminLoginAllowed(decoded.id)
              if (!loginOk.ok) {
                try {
                  await revokeAllSessions('admin', decoded.id)
                } catch {
                  /* ignore */
                }
                return res.status(401).json({
                  success: false,
                  message: loginOk.message || '该账号已被禁止登录',
                  code: loginOk.code || 'LOGIN_DISABLED',
                })
              }
            }
          } catch { /* fallthrough */ }
        }
        return res.status(401).json({
          success: false,
          message: '未登录或无权访问，请重新登录',
          code: 'UNAUTHORIZED',
        })
      }
      req.auth = auth
      req.admin = auth.decoded
      req.user = auth.decoded
      try {
        const { isSuperAdminId } = await import('./adminRoles.js')
        req.isSuperAdmin = await isSuperAdminId(auth.userId)
      } catch {
        req.isSuperAdmin = false
      }
      next()
    })
    .catch((e) => {
      console.error('[requireAdmin]', e)
      res.status(500).json({ success: false, message: '认证失败' })
    })
}

/** 仅超级管理员 */
export function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (!req.isSuperAdmin) {
      return res.status(403).json({ success: false, message: '需要超级管理员权限' })
    }
    next()
  })
}

/**
 * 超级管理员 + 校验超级管理密钥（写操作）
 * body.super_key 或 header x-super-key
 */
export function requireSuperAdminWithSecret(req, res, next) {
  requireSuperAdmin(req, res, async () => {
    try {
      const { verifySuperAdminSecret } = await import('./adminRoles.js')
      const key = req.body?.super_key || req.headers['x-super-key']
      if (!verifySuperAdminSecret(key)) {
        return res.status(403).json({
          success: false,
          message: '操作密钥错误',
          code: 'SUPER_KEY_INVALID',
        })
      }
      next()
    } catch (e) {
      console.error('[requireSuperAdminWithSecret]', e)
      res.status(500).json({ success: false, message: '鉴权失败' })
    }
  })
}

/** Express：仅学员 */
export function requireStudent(req, res, next) {
  authenticateRequest(req, { requireType: 'student' })
    .then((auth) => {
      if (!auth) {
        return res.status(401).json({ success: false, message: '未登录或会话已失效，请重新登录' })
      }
      req.auth = auth
      req.student = auth.decoded
      req.user = auth.decoded
      next()
    })
    .catch((e) => {
      console.error('[requireStudent]', e)
      res.status(500).json({ success: false, message: '认证失败' })
    })
}

/**
 * 对已带合法 JWT 的请求做二次闸门：账号删除 / 未绑邮箱 / 会话撤销立刻 401。
 * 无效 token 放行给业务路由自行处理（兼容公开接口）。
 */
export function identityGateMiddleware(req, res, next) {
  const token = extractBearer(req)
  if (!token) return next()

  let decoded
  try {
    decoded = jwt.verify(token, JWT_SECRET())
  } catch {
    return next()
  }

  ;(async () => {
    const userType = resolveUserType(decoded)
    if (!userType) return next()

    const active = await assertSessionActive(decoded)
    if (!active) {
      return res.status(401).json({ success: false, message: '会话已失效，请重新登录' })
    }

    const exists = await assertIdentityValid(decoded)
    if (!exists) {
      try {
        await revokeAllSessions(userType, decoded.id)
      } catch {
        /* ignore */
      }
      return res.status(401).json({
        success: false,
        message: '账号已不存在或已删除，请重新登录',
        code: 'ACCOUNT_GONE',
      })
    }

    if (userType === 'admin') {
      const emailOk = await assertAdminEmailBound(decoded.id)
      if (!emailOk) {
        try {
          await revokeAllSessions('admin', decoded.id)
        } catch {
          /* ignore */
        }
        return res.status(401).json({
          success: false,
          message: '该管理员未绑定安全邮箱，会话已失效。请联系超级管理员绑定后再登录',
          code: 'EMAIL_REQUIRED',
        })
      }

      const loginOk = await assertAdminLoginAllowed(decoded.id)
      if (!loginOk.ok) {
        try {
          await revokeAllSessions('admin', decoded.id)
        } catch {
          /* ignore */
        }
        return res.status(401).json({
          success: false,
          message: loginOk.message || '该账号已被禁止登录',
          code: loginOk.code || 'LOGIN_DISABLED',
        })
      }

      const bind = await assertAdminSessionBinding(req, decoded)
      if (!bind.ok) {
        return res.status(401).json({
          success: false,
          message: bind.message || '会话已失效，请重新登录',
          code: bind.code || 'SESSION_BINDING',
        })
      }
    }

    req.authUser = decoded
    void touchSession(decoded.jti)
    next()
  })().catch((e) => {
    console.error('[identityGate]', e)
    next()
  })
}

export function clientMeta(req) {
  return {
    ip: getClientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
  }
}
