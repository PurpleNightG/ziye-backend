import express from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../config/database.js'
import { requireAdmin } from '../utils/authGate.js'
import { ensureAuditLogTable, writeAdminAudit } from '../utils/adminAudit.js'
import { resolveAuditDisplay } from '../utils/auditDescribe.js'
import {
  listSessions,
  revokeAllSessions,
  revokeSession,
  ensureLoginSessionsTable,
} from '../utils/loginSessions.js'
import {
  ensureAdminRoleColumns,
  normalizeEmail,
  hasBoundEmail,
  verifySuperAdminSecret,
} from '../utils/adminRoles.js'
import { maskEmail } from '../utils/mailer.js'

const router = express.Router()
router.use(requireAdmin)

function assertCanMutate(req, res) {
  if (!req.isSuperAdmin) {
    res.status(403).json({
      success: false,
      message: '普通管理员仅可查看，不可踢人/改账号。请使用超级管理员并填写操作密钥。',
      code: 'SUPER_REQUIRED',
    })
    return false
  }
  const key = req.body?.super_key || req.headers['x-super-key']
  if (!verifySuperAdminSecret(key)) {
    res.status(403).json({
      success: false,
      message: '操作密钥错误',
      code: 'SUPER_KEY_INVALID',
    })
    return false
  }
  return true
}

/** 当前登录者权限摘要 */
router.get('/me', async (req, res) => {
  try {
    await ensureAdminRoleColumns()
    res.json({
      success: true,
      data: {
        is_super_admin: !!req.isSuperAdmin,
        can_kick: !!req.isSuperAdmin,
        can_manage_admins: !!req.isSuperAdmin,
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, message: '获取权限失败' })
  }
})

/** 管理员审计日志（全员只读） */
router.get('/audit-logs', async (req, res) => {
  try {
    await ensureAuditLogTable()

    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || Number(req.query.limit) || 20, 1), 100)
    const page = Math.max(Number(req.query.page) || 1, 1)
    const offset =
      req.query.offset != null
        ? Math.max(Number(req.query.offset) || 0, 0)
        : (page - 1) * pageSize
    const adminId = req.query.admin_id ? Number(req.query.admin_id) : null
    const q = String(req.query.q || '').trim()
    const from = String(req.query.from || '').trim()
    const to = String(req.query.to || '').trim()

    let where = ' WHERE 1=1'
    const params = []
    if (adminId) {
      where += ' AND admin_id = ?'
      params.push(adminId)
    }
    if (q) {
      where += ' AND (admin_username LIKE ? OR summary LIKE ? OR path LIKE ? OR ip LIKE ?)'
      const like = `%${q}%`
      params.push(like, like, like, like)
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where += ' AND created_at >= ?'
      params.push(`${from} 00:00:00`)
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where += ' AND created_at <= ?'
      params.push(`${to} 23:59:59`)
    }

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM admin_audit_logs${where}`,
      params
    )
    const total = Number(countRow?.total) || 0

    const [rows] = await pool.query(
      `SELECT id, admin_id, admin_username, action, method, path,
              resource_type, resource_id, summary, ip, user_agent, created_at
       FROM admin_audit_logs${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    )
    const data = rows.map((row) => {
      const { summary_tech, summary_human } = resolveAuditDisplay(row)
      return { ...row, summary_tech, summary_human }
    })
    res.json({
      success: true,
      data,
      meta: {
        total,
        page: Math.floor(offset / pageSize) + 1,
        pageSize,
      },
    })
  } catch (e) {
    console.error('[security] audit-logs', e)
    res.status(500).json({ success: false, message: '获取审计日志失败' })
  }
})

/** 所有管理员的登录会话总览（全员只读） */
router.get('/admin-sessions', async (req, res) => {
  try {
    await ensureLoginSessionsTable()
    await ensureAdminRoleColumns()
    const [admins] = await pool.query(
      'SELECT id, username, name, is_super_admin FROM admins ORDER BY is_super_admin DESC, id'
    )
    const result = []
    for (const a of admins) {
      const sessions = await listSessions('admin', a.id, null)
      result.push({
        admin_id: a.id,
        username: a.username,
        name: a.name,
        is_super_admin: Number(a.is_super_admin) === 1,
        sessions,
      })
    }
    res.json({ success: true, data: result, meta: { is_super_admin: !!req.isSuperAdmin } })
  } catch (e) {
    console.error('[security] admin-sessions', e)
    res.status(500).json({ success: false, message: '获取管理员会话失败' })
  }
})

/** 踢掉某管理员全部会话（超级管理员 + 密钥） */
router.post('/admins/:id/revoke-sessions', async (req, res) => {
  try {
    if (!assertCanMutate(req, res)) return
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ success: false, message: '无效管理员 ID' })
    const n = await revokeAllSessions('admin', id)
    await writeAdminAudit({
      req,
      action: 'revoke_admin_sessions',
      resourceType: 'admin',
      resourceId: id,
      summary: `强制登出管理员 #${id} 的全部会话（${n}）`,
    })
    res.json({ success: true, message: `已强制登出 ${n} 个会话`, data: { revoked: n } })
  } catch (e) {
    console.error('[security] revoke-sessions', e)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** 踢掉单条会话记录（超级管理员 + 密钥） */
router.post('/sessions/:rowId/revoke', async (req, res) => {
  try {
    if (!assertCanMutate(req, res)) return
    const rowId = Number(req.params.rowId)
    const adminId = Number(req.body?.admin_id)
    if (!rowId || !adminId) {
      return res.status(400).json({ success: false, message: '参数不完整' })
    }
    const currentJti = req.auth?.jti
    const result = await revokeSession('admin', adminId, rowId, currentJti)
    if (!result.ok) {
      const map = {
        not_found: '会话不存在',
        current: '不能踢掉当前正在使用的会话',
        already: '该会话已登出',
      }
      return res.status(400).json({ success: false, message: map[result.reason] || '操作失败' })
    }
    await writeAdminAudit({
      req,
      action: 'revoke_session',
      resourceType: 'login_session',
      resourceId: rowId,
      summary: `登出管理员 #${adminId} 的会话 #${rowId}`,
    })
    res.json({ success: true, message: '已登出该设备' })
  } catch (e) {
    console.error('[security] revoke session', e)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** 管理员账号列表（邮箱对普通管理员脱敏） */
router.get('/admins', async (req, res) => {
  try {
    await ensureAdminRoleColumns()
    const [rows] = await pool.query(
      `SELECT id, username, name, email, is_super_admin, login_disabled, created_at
       FROM admins ORDER BY is_super_admin DESC, id`
    )
    const data = rows.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      email: req.isSuperAdmin ? r.email : maskEmail(r.email),
      email_bound: hasBoundEmail(r.email),
      is_super_admin: Number(r.is_super_admin) === 1,
      login_disabled: Number(r.login_disabled) === 1,
      created_at: r.created_at,
    }))
    res.json({ success: true, data, meta: { is_super_admin: !!req.isSuperAdmin } })
  } catch (e) {
    console.error('[security] admins', e)
    res.status(500).json({ success: false, message: '获取管理员列表失败' })
  }
})

/** 绑定/修改管理员邮箱（仅超管 + 密钥）；普通管理员不能改自己的 */
router.put('/admins/:id/email', async (req, res) => {
  try {
    if (!assertCanMutate(req, res)) return
    await ensureAdminRoleColumns()
    const id = Number(req.params.id)
    const email = normalizeEmail(req.body?.email)
    if (!id) return res.status(400).json({ success: false, message: '无效 ID' })
    if (!hasBoundEmail(email)) {
      return res.status(400).json({ success: false, message: '请填写有效邮箱' })
    }
    const [r] = await pool.query('UPDATE admins SET email = ? WHERE id = ?', [email, id])
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '管理员不存在' })
    }
    await writeAdminAudit({
      req,
      action: 'bind_admin_email',
      resourceType: 'admin',
      resourceId: id,
      summary: `绑定管理员 #${id} 邮箱为 ${maskEmail(email)}`,
    })
    res.json({ success: true, message: '邮箱已更新', data: { email } })
  } catch (e) {
    console.error('[security] bind email', e)
    res.status(500).json({ success: false, message: '更新邮箱失败' })
  }
})

/** 创建管理员（仅超管 + 密钥） */
router.post('/admins', async (req, res) => {
  try {
    if (!assertCanMutate(req, res)) return
    await ensureAdminRoleColumns()
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    const name = String(req.body?.name || username).trim()
    const email = normalizeEmail(req.body?.email)
    const makeSuper = !!req.body?.is_super_admin

    if (!username || password.length < 6) {
      return res.status(400).json({ success: false, message: '用户名必填，密码至少 6 位' })
    }
    if (!hasBoundEmail(email)) {
      return res.status(400).json({ success: false, message: '必须绑定有效邮箱（否则无法登录）' })
    }

    const hashed = await bcrypt.hash(password, 10)
    try {
      const [r] = await pool.query(
        `INSERT INTO admins (username, password, name, email, is_super_admin)
         VALUES (?, ?, ?, ?, ?)`,
        [username, hashed, name, email, makeSuper ? 1 : 0]
      )
      await writeAdminAudit({
        req,
        action: 'create_admin',
        resourceType: 'admin',
        resourceId: r.insertId,
        summary: `创建管理员 ${username}${makeSuper ? '（超管）' : ''}`,
      })
      res.json({ success: true, message: '管理员已创建', data: { id: r.insertId } })
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ success: false, message: '用户名已存在' })
      }
      throw e
    }
  } catch (e) {
    console.error('[security] create admin', e)
    res.status(500).json({ success: false, message: '创建失败' })
  }
})

/** 设置/取消超级管理员（仅超管 + 密钥；不能取消自己） */
router.put('/admins/:id/super', async (req, res) => {
  try {
    if (!assertCanMutate(req, res)) return
    await ensureAdminRoleColumns()
    const id = Number(req.params.id)
    const flag = req.body?.is_super_admin ? 1 : 0
    if (!id) return res.status(400).json({ success: false, message: '无效 ID' })
    if (id === req.auth?.userId && flag === 0) {
      return res.status(400).json({ success: false, message: '不能取消自己的超级管理员身份' })
    }
    await pool.query('UPDATE admins SET is_super_admin = ? WHERE id = ?', [flag, id])
    await writeAdminAudit({
      req,
      action: 'set_super_admin',
      resourceType: 'admin',
      resourceId: id,
      summary: `${flag ? '授予' : '取消'}超级管理员 #${id}`,
    })
    res.json({ success: true, message: flag ? '已设为超级管理员' : '已取消超级管理员' })
  } catch (e) {
    console.error('[security] set super', e)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** 禁止 / 恢复管理员登录（仅超管 + 密钥；禁止时立刻踢下线；不能禁自己） */
router.put('/admins/:id/login-disabled', async (req, res) => {
  try {
    if (!assertCanMutate(req, res)) return
    await ensureAdminRoleColumns()
    const id = Number(req.params.id)
    const disabled = !!req.body?.login_disabled
    if (!id) return res.status(400).json({ success: false, message: '无效 ID' })
    if (id === req.auth?.userId) {
      return res.status(400).json({ success: false, message: '不能禁止自己的登录' })
    }
    const [r] = await pool.query('UPDATE admins SET login_disabled = ? WHERE id = ?', [
      disabled ? 1 : 0,
      id,
    ])
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '管理员不存在' })
    }
    if (disabled) {
      await revokeAllSessions('admin', id)
    }
    await writeAdminAudit({
      req,
      action: disabled ? 'disable_admin_login' : 'enable_admin_login',
      resourceType: 'admin',
      resourceId: id,
      summary: disabled ? `禁止管理员 #${id} 登录（已踢下线）` : `恢复管理员 #${id} 登录`,
    })
    res.json({
      success: true,
      message: disabled ? '已禁止登录，其会话已全部失效' : '已恢复登录权限',
    })
  } catch (e) {
    console.error('[security] login-disabled', e)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** 删除管理员（仅超管 + 密钥；不能删自己） */
router.delete('/admins/:id', async (req, res) => {
  try {
    if (!assertCanMutate(req, res)) return
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ success: false, message: '无效 ID' })
    if (id === req.auth?.userId) {
      return res.status(400).json({ success: false, message: '不能删除自己的账号' })
    }
    await revokeAllSessions('admin', id)
    const [r] = await pool.query('DELETE FROM admins WHERE id = ?', [id])
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '管理员不存在' })
    }
    await writeAdminAudit({
      req,
      action: 'delete_admin',
      resourceType: 'admin',
      resourceId: id,
      summary: `删除管理员 #${id}`,
    })
    res.json({ success: true, message: '管理员已删除，其会话已全部失效' })
  } catch (e) {
    console.error('[security] delete admin', e)
    res.status(500).json({ success: false, message: '删除失败' })
  }
})

export default router
