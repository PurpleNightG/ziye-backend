import { pool } from '../config/database.js'
import { resolveEffectiveClientIpAsync } from './clientIp.js'
import { describeAdminAction } from './auditDescribe.js'

let tableReady = false

export async function ensureAuditLogTable() {
  if (tableReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NULL,
      admin_username VARCHAR(100) NULL,
      action VARCHAR(64) NOT NULL COMMENT '动作类型',
      method VARCHAR(10) NULL,
      path VARCHAR(255) NULL,
      resource_type VARCHAR(64) NULL,
      resource_id VARCHAR(64) NULL,
      summary VARCHAR(500) NULL,
      detail_json MEDIUMTEXT NULL,
      ip VARCHAR(45) NULL,
      user_agent VARCHAR(512) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_aal_created (created_at),
      INDEX idx_aal_admin (admin_id, created_at),
      INDEX idx_aal_action (action, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='管理员操作审计'
  `)
  tableReady = true
}

/**
 * 写入一条审计（失败不影响主流程）
 */
export async function writeAdminAudit({
  req,
  action,
  resourceType = null,
  resourceId = null,
  summary = null,
  detail = null,
  /** 已解析的公网 IP（如登录流程），优先于自动探测 */
  ipOverride = null,
}) {
  try {
    await ensureAuditLogTable()
    const auth = req.auth || req.admin || req.authUser || {}
    const adminId = auth.userId || auth.id || auth.decoded?.id || null
    const username = auth.username || auth.decoded?.username || null
    // 与登录态一致：本地环回时用客户端公网 IP / 服务端出口 IP，避免审计列全是 ::1
    const ip =
      (ipOverride && String(ipOverride).slice(0, 45)) ||
      (await resolveEffectiveClientIpAsync(req, req.body?.clientPublicIp))
    const ua = String(req.headers['user-agent'] || '').slice(0, 512)
    let detailJson = null
    if (detail != null) {
      try {
        detailJson = JSON.stringify(detail).slice(0, 60000)
      } catch {
        detailJson = String(detail).slice(0, 2000)
      }
    }
    await pool.query(
      `INSERT INTO admin_audit_logs
         (admin_id, admin_username, action, method, path, resource_type, resource_id, summary, detail_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adminId,
        username,
        String(action || 'unknown').slice(0, 64),
        req.method || null,
        String(req.originalUrl || req.url || '').slice(0, 255),
        resourceType ? String(resourceType).slice(0, 64) : null,
        resourceId != null ? String(resourceId).slice(0, 64) : null,
        summary ? String(summary).slice(0, 500) : null,
        detailJson,
        ip,
        ua || null,
      ]
    )
  } catch (e) {
    console.warn('[audit]', e.message)
  }
}

/** 对管理员写操作自动记审计（挂在 requireAdmin 之后） */
export function adminAuditMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next()
  }

  const start = Date.now()
  const originalJson = res.json.bind(res)
  res.json = (body) => {
    const ok = body?.success !== false && res.statusCode < 400
    if (ok) {
      const path = String(req.originalUrl || req.path || '')
      const cleanPath = path.split('?')[0]
      const sanitizedBody = sanitizeBody(req.body)
      const { human } = describeAdminAction({
        method: req.method,
        path: cleanPath,
        body: sanitizedBody,
        params: req.params,
      })
      void writeAdminAudit({
        req,
        action: `${req.method}:${cleanPath}`.slice(0, 64),
        summary: human,
        detail: {
          status: res.statusCode,
          ms: Date.now() - start,
          params: req.params,
          query: req.query,
          // 不记录 password 等敏感字段
          body: sanitizedBody,
        },
      })
    }
    return originalJson(body)
  }
  next()
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body
  const clone = Array.isArray(body) ? [...body] : { ...body }
  const strip = [
    'password',
    'oldPassword',
    'newPassword',
    'confirmPassword',
    'token',
    'jwt',
    'super_key',
    'code',
    'otp',
    'otp_code',
    'verify_code',
    'smtp_pass',
    'SMTP_PASS',
  ]
  if (!Array.isArray(clone)) {
    for (const k of strip) {
      if (k in clone) clone[k] = '[redacted]'
    }
  }
  const raw = JSON.stringify(clone)
  if (raw.length > 4000) return { truncated: true, preview: raw.slice(0, 4000) }
  return clone
}
