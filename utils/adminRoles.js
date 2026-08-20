import { pool } from '../config/database.js'

let columnsReady = false

/** 确保 admins 表有超级管理员标记、禁止登录标记 */
export async function ensureAdminRoleColumns() {
  if (columnsReady) return
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins'
       AND COLUMN_NAME IN ('is_super_admin', 'login_disabled')`
  )
  const have = new Set(cols.map((c) => c.COLUMN_NAME))
  if (!have.has('is_super_admin')) {
    await pool.query(
      `ALTER TABLE admins
       ADD COLUMN is_super_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '超级管理员' AFTER email`
    )
  }
  if (!have.has('login_disabled')) {
    await pool.query(
      `ALTER TABLE admins
       ADD COLUMN login_disabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '禁止登录' AFTER is_super_admin`
    )
  }
  columnsReady = true
}

export async function getAdminById(id) {
  await ensureAdminRoleColumns()
  const [rows] = await pool.query(
    `SELECT id, username, name, email, avatar, is_super_admin, login_disabled, created_at
     FROM admins WHERE id = ? LIMIT 1`,
    [id]
  )
  return rows[0] || null
}

export async function isSuperAdminId(adminId) {
  const a = await getAdminById(adminId)
  return !!(a && Number(a.is_super_admin) === 1)
}

/** 管理员是否允许登录（未禁止） */
export async function assertAdminLoginAllowed(adminId) {
  try {
    await ensureAdminRoleColumns()
    const [rows] = await pool.query(
      'SELECT login_disabled FROM admins WHERE id = ? LIMIT 1',
      [adminId]
    )
    if (!rows.length) return { ok: false, code: 'ACCOUNT_GONE', message: '账号已不存在' }
    if (Number(rows[0].login_disabled) === 1) {
      return {
        ok: false,
        code: 'LOGIN_DISABLED',
        message: '该账号已被禁止登录',
      }
    }
    return { ok: true }
  } catch (e) {
    console.error('[adminRoles] assertAdminLoginAllowed', e.message)
    return { ok: false, code: 'LOGIN_CHECK_FAIL', message: '账号状态校验失败' }
  }
}

/** 踢人/删号等写操作密钥（与是否超管无关，超管也必须填写；仅存服务端环境变量） */
export function verifySuperAdminSecret(provided) {
  const expected = process.env.SUPER_ADMIN_SECRET || ''
  if (!expected) return false
  return String(provided || '') === expected
}

export function hasBoundEmail(email) {
  return !!(email && String(email).trim() && String(email).includes('@'))
}

/** 规范化邮箱 */
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}
