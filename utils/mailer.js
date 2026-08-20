import nodemailer from 'nodemailer'

let transporter = null

function smtpConfig() {
  // 与「光幕策校园墙」一致：smtp.qq.com + 587 + STARTTLS
  return {
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  }
}

export function isMailConfigured() {
  const c = smtpConfig()
  return !!(c.auth.user && c.auth.pass)
}

function getTransporter() {
  if (!isMailConfigured()) {
    throw new Error('邮件服务未配置（缺少 SMTP_USER / SMTP_PASS）')
  }
  if (!transporter) {
    transporter = nodemailer.createTransport(smtpConfig())
  }
  return transporter
}

export function maskEmail(email) {
  const s = String(email || '').trim()
  const at = s.indexOf('@')
  if (at <= 0) return '***'
  const name = s.slice(0, at)
  const domain = s.slice(at + 1)
  const show = name.length <= 2 ? name[0] : name.slice(0, 2)
  return `${show}***@${domain}`
}

function resolveFromName() {
  const raw = String(process.env.SMTP_FROM_NAME || '').trim()
  // .env 若用错误编码保存，会变成 � / 问号串；此时忽略环境变量
  // 发件显示名勿含「安全中心」（QQ 会屏蔽并退回账号名）
  if (!raw || raw.includes('\uFFFD') || /\?{3,}/.test(raw)) {
    return '紫夜战术公会'
  }
  return raw
}

/**
 * 发送登录验证码
 * from 用标准字符串：`"昵称" <邮箱>`（nodemailer 自动处理中文编码）
 */
export async function sendLoginOtpMail(to, code) {
  const fromUser = process.env.SMTP_USER
  const fromName = resolveFromName()
  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromUser}>`,
    to,
    subject: '【紫夜安全中心】管理员登录验证码',
    text: `您正在进行管理员登录二次验证。\n\n验证码：${code}\n\n5 分钟内有效。如非本人操作，请立即修改密码并联系超级管理员。\n\n— 紫夜安全中心`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f0f14;color:#e8e8ef;border-radius:12px">
        <h2 style="color:#c4b5fd;margin:0 0 12px">紫夜安全中心</h2>
        <p style="margin:0 0 16px;color:#a1a1aa">检测到管理员登录环境变化（IP 或新设备），请使用验证码完成二次验证：</p>
        <div style="font-size:28px;letter-spacing:8px;font-weight:700;color:#fff;background:#1f1633;padding:16px 20px;border-radius:8px;text-align:center">${code}</div>
        <p style="margin:16px 0 0;font-size:13px;color:#71717a">验证码 5 分钟内有效。如非本人操作，请立即修改密码并联系超级管理员。</p>
      </div>
    `,
  })
  return info
}
