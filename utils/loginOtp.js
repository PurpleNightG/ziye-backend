import crypto from 'crypto'
import { pool } from '../config/database.js'
import { sendLoginOtpMail, maskEmail, isMailConfigured } from './mailer.js'

let tableReady = false
const PENDING_HASH = 'PENDING'

export async function ensureLoginOtpTable() {
  if (tableReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_login_challenges (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      challenge_id CHAR(36) NOT NULL,
      admin_id INT NOT NULL,
      username VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      client_ip VARCHAR(45) NULL,
      device_name VARCHAR(160) NULL,
      remember_me TINYINT(1) NOT NULL DEFAULT 1,
      attempts INT NOT NULL DEFAULT 0,
      mail_sent_at DATETIME NULL,
      expires_at DATETIME NOT NULL,
      consumed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_challenge (challenge_id),
      INDEX idx_admin_exp (admin_id, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  const [cols] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'admin_login_challenges'
      AND COLUMN_NAME = 'mail_sent_at'
  `)
  if (!cols.length) {
    await pool.query(`
      ALTER TABLE admin_login_challenges
        ADD COLUMN mail_sent_at DATETIME NULL COMMENT '验证码邮件发送时间' AFTER attempts
    `)
  }
  tableReady = true
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex')
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/**
 * 密码通过且需二次验证后：只创建待发送挑战，不发邮件、不返回明文验证码
 */
export async function createPendingLoginChallenge({
  adminId,
  username,
  email,
  clientIp,
  deviceName,
  rememberMe,
}) {
  await ensureLoginOtpTable()
  if (!hasBoundEmail(email)) {
    const err = new Error('该管理员未绑定邮箱')
    err.code = 'EMAIL_REQUIRED'
    throw err
  }

  const challengeId = crypto.randomUUID()
  await pool.query(
    `INSERT INTO admin_login_challenges
       (challenge_id, admin_id, username, email, code_hash, client_ip, device_name, remember_me, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
    [
      challengeId,
      adminId,
      username,
      email,
      PENDING_HASH,
      clientIp || null,
      deviceName || null,
      rememberMe ? 1 : 0,
    ]
  )

  return {
    challenge_id: challengeId,
    email_hint: maskEmail(email),
    mail_sent: false,
  }
}

function hasBoundEmail(email) {
  return !!(email && String(email).includes('@'))
}

/**
 * 用户确认后发送验证码。明文只走 SMTP，接口只返回脱敏邮箱。
 */
export async function sendLoginOtpForChallenge(challengeId) {
  await ensureLoginOtpTable()
  if (!isMailConfigured()) {
    const err = new Error('邮件服务未配置，无法发送验证码')
    err.code = 'MAIL_NOT_CONFIGURED'
    throw err
  }

  const id = String(challengeId || '').trim()
  const [rows] = await pool.query(
    `SELECT * FROM admin_login_challenges WHERE challenge_id = ? LIMIT 1`,
    [id]
  )
  if (!rows.length) {
    const err = new Error('验证已失效，请重新登录')
    err.code = 'OTP_GONE'
    throw err
  }
  const row = rows[0]
  if (row.consumed_at) {
    const err = new Error('验证已使用，请重新登录')
    err.code = 'OTP_USED'
    throw err
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    const err = new Error('验证已过期，请重新登录')
    err.code = 'OTP_EXPIRED'
    throw err
  }

  if (row.mail_sent_at) {
    const elapsed = Date.now() - new Date(row.mail_sent_at).getTime()
    if (elapsed < 60_000) {
      const err = new Error(`请 ${Math.ceil((60_000 - elapsed) / 1000)} 秒后再重新发送`)
      err.code = 'OTP_RATE'
      throw err
    }
  }

  const code = genCode()
  await pool.query(
    `UPDATE admin_login_challenges
     SET code_hash = ?, mail_sent_at = NOW(), attempts = 0,
         expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)
     WHERE id = ?`,
    [hashCode(code), row.id]
  )

  // 明文验证码仅用于发信，绝不写入接口响应
  await sendLoginOtpMail(row.email, code)

  return {
    challenge_id: row.challenge_id,
    email_hint: maskEmail(row.email),
    expires_in: 300,
    mail_sent: true,
  }
}

export async function verifyLoginOtp(challengeId, code) {
  await ensureLoginOtpTable()
  const [rows] = await pool.query(
    `SELECT * FROM admin_login_challenges WHERE challenge_id = ? LIMIT 1`,
    [challengeId]
  )
  if (!rows.length) return { ok: false, reason: 'not_found' }
  const row = rows[0]
  if (row.consumed_at) return { ok: false, reason: 'used' }
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' }
  if (row.code_hash === PENDING_HASH || !row.mail_sent_at) {
    return { ok: false, reason: 'not_sent' }
  }
  if (Number(row.attempts) >= 8) return { ok: false, reason: 'locked' }

  const match = hashCode(String(code || '').trim()) === row.code_hash
  if (!match) {
    await pool.query(
      `UPDATE admin_login_challenges SET attempts = attempts + 1 WHERE id = ?`,
      [row.id]
    )
    return { ok: false, reason: 'bad_code' }
  }

  await pool.query(
    `UPDATE admin_login_challenges SET consumed_at = NOW() WHERE id = ?`,
    [row.id]
  )

  return {
    ok: true,
    adminId: row.admin_id,
    username: row.username,
    clientIp: row.client_ip,
    deviceName: row.device_name,
    rememberMe: Number(row.remember_me) === 1,
  }
}
