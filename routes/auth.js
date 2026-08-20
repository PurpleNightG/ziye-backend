import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from '../config/database.js'
import { createLoginSession, assertSessionActive, touchSession, revokeAllSessions, revokeOtherSessions } from '../utils/loginSessions.js'
import { assertIdentityValid, assertAdminEmailBound } from '../utils/authGate.js'
import { assertAdminSessionBinding } from '../utils/sessionBinding.js'
import { getClientIp } from '../utils/loginSessions.js'
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from '../utils/loginRateLimit.js'
import { resolveEffectiveClientIpAsync, evaluateRemoteLogin } from '../utils/clientIp.js'
import { createPendingLoginChallenge, sendLoginOtpForChallenge, verifyLoginOtp } from '../utils/loginOtp.js'
import {
  ensureAdminRoleColumns,
  hasBoundEmail,
  getAdminById,
  assertAdminLoginAllowed,
} from '../utils/adminRoles.js'
import { parseDeviceName } from '../utils/loginSessions.js'
import { writeAdminAudit } from '../utils/adminAudit.js'

const router = express.Router()

function issueAdminToken(user, sessionId, rememberMe) {
  // 与登录页「记住登录（7天）」及学员端一致；未勾选则 1 天（仍可用 local/session 存储区分关浏览器）
  const expiresIn = rememberMe ? '7d' : '1d'
  const isSuper = Number(user.is_super_admin) === 1
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      userType: 'admin',
      is_super_admin: isSuper ? 1 : 0,
      jti: sessionId,
    },
    process.env.JWT_SECRET,
    { expiresIn }
  )
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      userType: 'admin',
      avatar: user.avatar || null,
      email: user.email || null,
      is_super_admin: isSuper,
    },
  }
}

async function completeAdminLogin(req, res, user, { rememberMe, clientIp, deviceName, deviceFingerprint }) {
  const sessionId = await createLoginSession(req, {
    userType: 'admin',
    userId: user.id,
    deviceName,
    rememberMe,
    ipOverride: clientIp,
    deviceFingerprint,
  })
  // 单点登录：仅保留当前会话
  try {
    await revokeOtherSessions('admin', user.id, sessionId)
  } catch { /* ignore */ }
  const payload = issueAdminToken(user, sessionId, rememberMe)
  try {
    req.auth = { userId: user.id, username: user.username, id: user.id }
    await writeAdminAudit({
      req,
      action: 'admin_login',
      resourceType: 'admin',
      resourceId: user.id,
      summary: `管理员登录成功 IP=${clientIp || '?'}（单点，已踢其它会话）`,
      ipOverride: clientIp,
    })
  } catch { /* ignore */ }
  return res.json({ success: true, message: '登录成功', data: payload })
}

router.post('/login', async (req, res) => {
  try {
    const { username, password, userType } = req.body
    const rememberMe = req.body?.rememberMe !== false && req.body?.rememberMe !== 0
    const rateIp = getClientIp(req)

    if (!username || !password || !userType) {
      return res.status(400).json({
        success: false,
        message: '请提供用户名、密码和用户类型',
      })
    }

    const rate = checkLoginAllowed(rateIp, username)
    if (!rate.ok) {
      return res.status(429).json({ success: false, message: rate.message })
    }

    // 学员仍走旧 students 表（若仍使用）；管理走 admins + 异地二次验证
    if (userType !== 'admin') {
      const [users] = await pool.query(`SELECT * FROM students WHERE username = ?`, [username])
      if (users.length === 0) {
        recordLoginFailure(rateIp, username)
        return res.status(401).json({ success: false, message: '用户名或密码错误' })
      }
      const user = users[0]
      const isPasswordValid = await bcrypt.compare(password, user.password)
      if (!isPasswordValid) {
        recordLoginFailure(rateIp, username)
        return res.status(401).json({ success: false, message: '用户名或密码错误' })
      }
      recordLoginSuccess(rateIp, username)
      const sessionId = await createLoginSession(req, {
        userType: 'student',
        userId: user.id,
        deviceName: req.body?.deviceName,
        rememberMe,
      })
      const token = jwt.sign(
        { id: user.id, username: user.username, userType, jti: sessionId },
        process.env.JWT_SECRET,
        { expiresIn: rememberMe ? '7d' : '1d' }
      )
      return res.json({
        success: true,
        message: '登录成功',
        data: {
          token,
          user: {
            id: user.id,
            username: user.username,
            name: user.name || username,
            userType,
            avatar: user.avatar || null,
          },
        },
      })
    }

    await ensureAdminRoleColumns()
    const [users] = await pool.query(`SELECT * FROM admins WHERE username = ?`, [username])
    if (users.length === 0) {
      recordLoginFailure(rateIp, username)
      return res.status(401).json({ success: false, message: '用户名或密码错误' })
    }

    const user = users[0]
    const isPasswordValid = await bcrypt.compare(password, user.password)
    if (!isPasswordValid) {
      recordLoginFailure(rateIp, username)
      return res.status(401).json({ success: false, message: '用户名或密码错误' })
    }

    if (!hasBoundEmail(user.email)) {
      return res.status(403).json({
        success: false,
        message: '该管理员未绑定安全邮箱，请联系超级管理员绑定后再登录',
        code: 'EMAIL_REQUIRED',
      })
    }

    if (Number(user.login_disabled) === 1) {
      return res.status(403).json({
        success: false,
        message: '该账号已被禁止登录，请联系超级管理员',
        code: 'LOGIN_DISABLED',
      })
    }

    const clientIp = await resolveEffectiveClientIpAsync(req, req.body?.clientPublicIp)
    const deviceName =
      (req.body?.deviceName && String(req.body.deviceName).trim().slice(0, 160)) ||
      parseDeviceName(req.headers['user-agent'])
    const deviceFingerprint =
      String(req.body?.deviceFingerprint || req.headers['x-device-fingerprint'] || '')
        .trim()
        .slice(0, 128) || null

    const remoteCheck = await evaluateRemoteLogin(
      user.id,
      clientIp,
      deviceFingerprint,
      req.headers['user-agent']
    )
    if (remoteCheck.remote) {
      try {
        const pending = await createPendingLoginChallenge({
          adminId: user.id,
          username: user.username,
          email: user.email,
          clientIp,
          deviceName,
          rememberMe,
        })
        const reasonText = remoteCheck.reasons.includes('first')
          ? '首次登录需验证本人身份'
          : remoteCheck.reasons.includes('concurrent')
            ? '已有登录会话，需验证后继续（验证成功将使其它设备下线）'
            : remoteCheck.reasons.includes('device') || remoteCheck.reasons.includes('browser')
              ? remoteCheck.reasons.includes('ip')
                ? '检测到 IP 与登录设备均变化'
                : '检测到更换浏览器/设备'
              : '检测到 IP 变化'
        return res.json({
          success: true,
          message: `${reasonText}，请确认后发送邮箱验证码`,
          data: {
            require_otp: true,
            mail_sent: false,
            challenge_id: pending.challenge_id,
            email_hint: pending.email_hint,
            reasons: remoteCheck.reasons,
          },
        })
      } catch (e) {
        console.error('[auth] pending otp', e)
        return res.status(500).json({
          success: false,
          message: e.message || '无法发起二次验证',
          code: e.code || 'OTP_PENDING_FAIL',
        })
      }
    }

    recordLoginSuccess(rateIp, username)
    return completeAdminLogin(req, res, user, {
      rememberMe,
      clientIp,
      deviceName,
      deviceFingerprint,
    })
  } catch (error) {
    console.error('登录错误:', error)
    res.status(500).json({
      success: false,
      message: '服务器错误，请稍后重试',
    })
  }
})

/** 异地登录：提交邮箱验证码完成登录 */
router.post('/login/verify-otp', async (req, res) => {
  try {
    const challengeId = String(req.body?.challenge_id || '').trim()
    const code = String(req.body?.code || '').trim()
    if (!challengeId || !code) {
      return res.status(400).json({ success: false, message: '请提供验证码' })
    }

    const result = await verifyLoginOtp(challengeId, code)
    if (!result.ok) {
      const map = {
        not_found: '验证已失效，请重新登录',
        used: '验证码已使用，请重新登录',
        expired: '验证码已过期，请重新登录',
        locked: '尝试次数过多，请重新登录',
        bad_code: '验证码错误',
        not_sent: '请先确认并发送邮箱验证码',
      }
      return res.status(401).json({
        success: false,
        message: map[result.reason] || '验证失败',
        code: 'OTP_INVALID',
      })
    }

    await ensureAdminRoleColumns()
    const user = await getAdminById(result.adminId)
    if (!user) {
      return res.status(401).json({ success: false, message: '账号已不存在' })
    }
    // getAdminById 不含 password/avatar 全字段；补查
    const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [result.adminId])
    const full = rows[0]
    if (!full) {
      return res.status(401).json({ success: false, message: '账号已不存在' })
    }

    const loginOk = await assertAdminLoginAllowed(full.id)
    if (!loginOk.ok) {
      return res.status(403).json({
        success: false,
        message: loginOk.message || '该账号已被禁止登录',
        code: loginOk.code || 'LOGIN_DISABLED',
      })
    }

    recordLoginSuccess(result.clientIp || getClientIp(req), full.username)
    const deviceFingerprint =
      String(req.body?.deviceFingerprint || req.headers['x-device-fingerprint'] || '')
        .trim()
        .slice(0, 128) || null
    return completeAdminLogin(req, res, full, {
      rememberMe: result.rememberMe,
      clientIp: result.clientIp || (await resolveEffectiveClientIpAsync(req, req.body?.clientPublicIp)),
      deviceName: result.deviceName,
      deviceFingerprint,
    })
  } catch (error) {
    console.error('[auth] verify-otp', error)
    res.status(500).json({ success: false, message: '验证失败，请稍后重试' })
  }
})

/** 用户确认后发送邮箱验证码（明文只走 SMTP，响应中不含验证码） */
router.post('/login/send-otp', async (req, res) => {
  try {
    const challengeId = String(req.body?.challenge_id || '').trim()
    if (!challengeId) {
      return res.status(400).json({ success: false, message: '缺少验证凭证' })
    }
    const result = await sendLoginOtpForChallenge(challengeId)
    res.json({
      success: true,
      message: `验证码已发送至 ${result.email_hint}`,
      data: {
        challenge_id: result.challenge_id,
        email_hint: result.email_hint,
        expires_in: result.expires_in,
        mail_sent: true,
      },
    })
  } catch (e) {
    console.error('[auth] send-otp', e)
    const status =
      e.code === 'OTP_RATE'
        ? 429
        : e.code === 'OTP_GONE' || e.code === 'OTP_EXPIRED' || e.code === 'OTP_USED'
          ? 401
          : 500
    res.status(status).json({
      success: false,
      message: e.message || '发送失败',
      code: e.code || 'OTP_SEND_FAIL',
    })
  }
})

/** 本机出口公网 IP（供本地前端会话绑定，避免浏览器直连外网 IP 服务失败） */
router.get('/egress-ip', async (_req, res) => {
  try {
    const { getServerEgressIp } = await import('../utils/clientIp.js')
    const ip = await getServerEgressIp()
    res.json({ success: true, data: { ip: ip || null } })
  } catch (e) {
    console.error('[auth] egress-ip', e)
    res.json({ success: true, data: { ip: null } })
  }
})

router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const active = await assertSessionActive(decoded)
    if (!active) {
      return res.status(401).json({ success: false, message: '会话已失效，请重新登录' })
    }

    const exists = await assertIdentityValid(decoded)
    if (!exists) {
      const ut = decoded.userType === 'admin' ? 'admin' : 'student'
      try {
        await revokeAllSessions(ut, decoded.id)
      } catch { /* ignore */ }
      return res.status(401).json({
        success: false,
        message: '账号已不存在或已删除，请重新登录',
        code: 'ACCOUNT_GONE',
      })
    }

    if (decoded.userType === 'admin') {
      const emailOk = await assertAdminEmailBound(decoded.id)
      if (!emailOk) {
        try {
          await revokeAllSessions('admin', decoded.id)
        } catch { /* ignore */ }
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
        } catch { /* ignore */ }
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

    void touchSession(decoded.jti)

    let avatar = null
    let displayName = decoded.username
    let isSuper = false
    let email = null
    try {
      if (decoded.userType === 'admin') {
        await ensureAdminRoleColumns()
        const [rows] = await pool.query(
          'SELECT name, username, avatar, email, is_super_admin FROM admins WHERE id = ?',
          [decoded.id]
        )
        if (rows[0]) {
          avatar = rows[0].avatar || null
          displayName = rows[0].name || rows[0].username || decoded.username
          isSuper = Number(rows[0].is_super_admin) === 1
          email = rows[0].email || null
        }
      }
    } catch { /* ignore */ }

    res.json({
      success: true,
      data: {
        id: decoded.id,
        username: decoded.username,
        display_name: displayName,
        name: displayName,
        avatar,
        email,
        is_super_admin: isSuper,
        userType: decoded.userType,
      },
    })
  } catch (error) {
    console.error('Token验证错误:', error)
    res.status(401).json({ success: false, message: '认证令牌无效或已过期' })
  }
})

router.put('/change-password', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const active = await assertSessionActive(decoded)
    if (!active) {
      return res.status(401).json({ success: false, message: '会话已失效，请重新登录' })
    }
    if (!(await assertIdentityValid(decoded))) {
      return res.status(401).json({ success: false, message: '账号已失效' })
    }

    const { oldPassword, newPassword } = req.body
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: '请提供旧密码和新密码' })
    }

    const tableName = decoded.userType === 'admin' ? 'admins' : 'students'
    const [users] = await pool.query(`SELECT * FROM ${tableName} WHERE id = ?`, [decoded.id])
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, users[0].password)
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: '旧密码错误' })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await pool.query(`UPDATE ${tableName} SET password = ? WHERE id = ?`, [hashedPassword, decoded.id])

    const ut = decoded.userType === 'admin' ? 'admin' : 'student'
    await revokeAllSessions(ut, decoded.id)

    res.json({ success: true, message: '密码修改成功，请重新登录', data: { force_relogin: true } })
  } catch (error) {
    console.error('修改密码错误:', error)
    res.status(500).json({ success: false, message: '服务器错误，请稍后重试' })
  }
})

export default router
