import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from '../config/database.js'
import {
  assertSessionActive,
  listSessions,
  revokeSession,
  revokeCurrentSession,
  deleteSession,
  revokeOtherSessions,
  revokeAllSessions,
  touchSession,
  MAX_LOGIN_SESSIONS,
} from '../utils/loginSessions.js'
import { assertIdentityValid, resolveUserType } from '../utils/authGate.js'

const router = express.Router()
const JWT_SECRET = () => process.env.JWT_SECRET || 'your-secret-key'

async function requireAuth(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    res.status(401).json({ success: false, message: '未登录' })
    return null
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET())
    const active = await assertSessionActive(decoded)
    if (!active) {
      res.status(401).json({ success: false, message: '会话已失效，请重新登录' })
      return null
    }
    if (!(await assertIdentityValid(decoded))) {
      const userType = resolveUserType(decoded)
      if (userType) {
        try {
          await revokeAllSessions(userType, decoded.id)
        } catch { /* ignore */ }
      }
      res.status(401).json({ success: false, message: '账号已不存在或已删除，请重新登录', code: 'ACCOUNT_GONE' })
      return null
    }
    void touchSession(decoded.jti)
    const userType = resolveUserType(decoded)
    return { token, decoded, userType, userId: decoded.id, jti: decoded.jti || null, username: decoded.username }
  } catch {
    res.status(401).json({ success: false, message: '登录已过期，请重新登录' })
    return null
  }
}

async function ensureAvatarColumns() {
  for (const table of ['members', 'admins']) {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'avatar'`,
      [table]
    )
    if (cols.length === 0) {
      await pool.query(
        `ALTER TABLE ${table}
         ADD COLUMN avatar MEDIUMTEXT NULL COMMENT '头像 data URL' AFTER password`
      )
    }
  }
}

/** GET /profile */
router.get('/profile', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    await ensureAvatarColumns()
    // admins.is_super_admin 可能尚未迁移
    try {
      const { ensureAdminRoleColumns } = await import('../utils/adminRoles.js')
      await ensureAdminRoleColumns()
    } catch { /* ignore */ }

    if (auth.userType === 'student') {
      const [rows] = await pool.query(
        'SELECT id, username, nickname, qq, avatar, stage_role, status FROM members WHERE id = ?',
        [auth.userId]
      )
      if (!rows.length) {
        return res.status(404).json({ success: false, message: '用户不存在' })
      }
      const m = rows[0]
      return res.json({
        success: true,
        data: {
          user_type: 'student',
          id: m.id,
          username: m.username,
          display_name: m.nickname || m.username,
          qq: m.qq,
          avatar: m.avatar || null,
          stage_role: m.stage_role,
        },
      })
    }

    const [rows] = await pool.query(
      'SELECT id, username, name, email, avatar, is_super_admin FROM admins WHERE id = ?',
      [auth.userId]
    )
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }
    const a = rows[0]
    return res.json({
      success: true,
      data: {
        user_type: 'admin',
        id: a.id,
        username: a.username,
        display_name: a.name || a.username,
        email: a.email,
        avatar: a.avatar || null,
        is_super_admin: Number(a.is_super_admin) === 1,
      },
    })
  } catch (error) {
    console.error('[account-security] profile', error)
    res.status(500).json({ success: false, message: '获取资料失败' })
  }
})

/** PUT /password */
router.put('/password', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const { oldPassword, newPassword } = req.body || {}
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: '请填写旧密码和新密码' })
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少 6 位' })
    }

    const table = auth.userType === 'student' ? 'members' : 'admins'
    const [rows] = await pool.query(`SELECT id, password FROM ${table} WHERE id = ?`, [auth.userId])
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }
    const ok = await bcrypt.compare(oldPassword, rows[0].password)
    if (!ok) {
      return res.status(401).json({ success: false, message: '旧密码错误' })
    }
    const hashed = await bcrypt.hash(String(newPassword), 10)
    await pool.query(`UPDATE ${table} SET password = ? WHERE id = ?`, [hashed, auth.userId])
    // 改密后强制全部重新登录（含当前），防止旧 token 被盗用
    await revokeAllSessions(auth.userType, auth.userId)
    res.json({
      success: true,
      message: '密码已修改，请重新登录',
      data: { force_relogin: true, revoked_others: 0 },
    })
  } catch (error) {
    console.error('[account-security] password', error)
    res.status(500).json({ success: false, message: '修改密码失败' })
  }
})

/** PUT /avatar  body: { avatar: dataURL } 或 { avatar: null } 清除 */
router.put('/avatar', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    await ensureAvatarColumns()

    let avatar = req.body?.avatar
    if (avatar === null || avatar === '') {
      avatar = null
    } else if (typeof avatar === 'string') {
      if (!avatar.startsWith('data:image/')) {
        return res.status(400).json({ success: false, message: '头像格式无效' })
      }
      if (avatar.length > 350_000) {
        return res.status(400).json({ success: false, message: '头像过大，请压缩后再传（建议 ≤200KB）' })
      }
    } else {
      return res.status(400).json({ success: false, message: '请上传头像' })
    }

    const table = auth.userType === 'student' ? 'members' : 'admins'
    await pool.query(`UPDATE ${table} SET avatar = ? WHERE id = ?`, [avatar, auth.userId])
    res.json({ success: true, message: avatar ? '头像已更新' : '头像已清除', data: { avatar } })
  } catch (error) {
    console.error('[account-security] avatar', error)
    res.status(500).json({ success: false, message: '更新头像失败' })
  }
})

/** POST /heartbeat — 标签页保活（仅刷新 last_active_at，requireAuth 内已 touch） */
router.post('/heartbeat', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    res.json({ success: true })
  } catch (error) {
    console.error('[account-security] heartbeat', error)
    res.status(500).json({ success: false, message: '心跳失败' })
  }
})

/** GET /sessions */
router.get('/sessions', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const sessions = await listSessions(auth.userType, auth.userId, auth.jti)
    res.json({ success: true, data: sessions, meta: { max: MAX_LOGIN_SESSIONS } })
  } catch (error) {
    console.error('[account-security] sessions', error)
    res.status(500).json({ success: false, message: '获取登录设备失败' })
  }
})

/** POST /logout — 退出当前设备（右上角退出登录） */
router.post('/logout', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = await revokeCurrentSession(auth.userType, auth.userId, auth.jti)
    if (!result.ok && result.reason === 'no_jti') {
      return res.json({
        success: true,
        message: '已退出（旧版令牌无会话记录，请重新登录后生效）',
      })
    }
    res.json({ success: true, message: '已退出登录' })
  } catch (error) {
    console.error('[account-security] logout current', error)
    res.status(500).json({ success: false, message: '退出失败' })
  }
})

/** POST /sessions/:id/logout — 登出该设备（保留记录） */
router.post('/sessions/:id/logout', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const id = parseInt(req.params.id, 10)
    if (!id) {
      return res.status(400).json({ success: false, message: '无效会话' })
    }
    const result = await revokeSession(auth.userType, auth.userId, id, auth.jti)
    if (!result.ok) {
      if (result.reason === 'current') {
        return res.status(400).json({ success: false, message: '不能登出当前设备，请使用退出登录' })
      }
      if (result.reason === 'already') {
        return res.status(400).json({ success: false, message: '该设备已处于登出状态' })
      }
      return res.status(404).json({ success: false, message: '记录不存在' })
    }
    res.json({ success: true, message: '已登出该设备' })
  } catch (error) {
    console.error('[account-security] logout session', error)
    res.status(500).json({ success: false, message: '登出失败' })
  }
})

/** DELETE /sessions/others — 登出其它设备（保留记录） */
router.delete('/sessions/others', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const n = await revokeOtherSessions(auth.userType, auth.userId, auth.jti)
    res.json({
      success: true,
      message: n > 0 ? `已登出其它 ${n} 台设备` : '没有其它在线设备',
      data: { revoked: n },
    })
  } catch (error) {
    console.error('[account-security] revoke others', error)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** DELETE /sessions/:id — 仅删除记录（须已登出） */
router.delete('/sessions/:id', async (req, res) => {
  try {
    const auth = await requireAuth(req, res)
    if (!auth) return
    const id = parseInt(req.params.id, 10)
    if (!id) {
      return res.status(400).json({ success: false, message: '无效会话' })
    }

    const result = await deleteSession(auth.userType, auth.userId, id, auth.jti)
    if (!result.ok) {
      if (result.reason === 'current') {
        return res.status(400).json({ success: false, message: '不能删除当前设备记录' })
      }
      if (result.reason === 'still_active') {
        return res.status(400).json({ success: false, message: '设备仍在线，请先登出再删除记录' })
      }
      return res.status(404).json({ success: false, message: '记录不存在' })
    }
    res.json({ success: true, message: '已删除该登录记录' })
  } catch (error) {
    console.error('[account-security] delete session', error)
    res.status(500).json({ success: false, message: '删除失败' })
  }
})

export { revokeAllSessions }
export default router
