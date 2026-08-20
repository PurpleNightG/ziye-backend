import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { testConnection, closePool } from './config/database.js'
import authRoutes from './routes/auth.js'
import studentAuthRoutes from './routes/student-auth.js'
import membersRoutes from './routes/members.js'
import leavesRoutes from './routes/leaves.js'
import blackpointsRoutes from './routes/blackpoints.js'
import remindersRoutes from './routes/reminders.js'
import quitRoutes from './routes/quit.js'
import retentionRoutes from './routes/retention.js'
import coursesRoutes from './routes/courses.js'
import progressRoutes from './routes/progress.js'
import settingsRoutes from './routes/settings.js'
import assessmentsRoutes from './routes/assessments.js'
import assessmentApplicationsRoutes from './routes/assessmentApplications.js'
import assessmentGuidelinesRoutes from './routes/assessmentGuidelines.js'
import publicVideosRoutes from './routes/publicVideos.js'
import videoUploadRoutes from './routes/videoUpload.js'
import classmatesRoutes from './routes/classmates.js'
import turnRoutes from './routes/turn.js'
import volcRoutes from './routes/volc.js'
import roomRoutes from './routes/room.js'
import meetingRoutes from './routes/meeting.js'
import ziyeRoutes from './routes/ziye.js'
import versionsRoutes from './routes/versions.js'
import dutyRoutes from './routes/duty.js'
import docsRoutes from './routes/docs.js'
import badgesRoutes, { invalidateBadgeCache } from './routes/badges.js'
import anticheatRoutes from './routes/anticheat.js'
import surveysRoutes from './routes/surveys.js'
import sheetsRoutes from './routes/sheets.js'
import opinionBoxRoutes from './routes/opinionBox.js'
import accountSecurityRoutes from './routes/accountSecurity.js'
import assistantRoutes from './routes/assistant.js'
import securityRoutes from './routes/security.js'
import checkinsRoutes from './routes/checkins.js'
import adminAiRoutes from './routes/adminAi.js'
import { requireAdmin, identityGateMiddleware } from './utils/authGate.js'
import { adminAuditMiddleware, ensureAuditLogTable } from './utils/adminAudit.js'
import { ensureAdminRoleColumns } from './utils/adminRoles.js'
import { ensureLoginOtpTable } from './utils/loginOtp.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 8000

const trustProxy =
  process.env.TRUST_PROXY === '1' ||
  process.env.TRUST_PROXY === 'true' ||
  process.env.TRUST_PROXY === 'yes'
if (trustProxy) {
  // 生产反代（Nginx/Caddy 等）后，让 Express 与 getClientIp 信任 X-Forwarded-For
  app.set('trust proxy', 1)
}

const adminGuard = [requireAdmin, adminAuditMiddleware]

/** 混合路由：白名单路径（可限制方法）以外要求管理员 */
function requireAdminUnless(rules) {
  const normalized = rules.map((r) =>
    typeof r === 'string' ? { path: r, methods: null } : r
  )
  return (req, res, next) => {
    const p = req.path || ''
    const method = req.method
    const hit = normalized.some((r) => {
      if (!r.methods || r.methods.includes(method)) {
        if (r.path === '*') return true
        if (r.path === '/') return p === '/' || (r.includeSubpaths && p.startsWith('/'))
        return p === r.path || p.startsWith(r.path + '/')
      }
      return false
    })
    if (hit) return next()
    return requireAdmin(req, res, () => adminAuditMiddleware(req, res, next))
  }
}

// CORS配置 - 允许的来源
const allowedOrigins = [
  'http://localhost:5173',       // 本地开发前端
  'http://localhost:3001',       // 本地开发前端备用端口
  'http://localhost:3002',       // 本地开发前端备用端口
  'http://127.0.0.1:5173',
  'https://sh01.eu.org',         // 自定义域名
  'http://sh01.eu.org',
  process.env.FRONTEND_URL,      // 生产环境前端URL（通过环境变量配置）
]

// 中间件
app.use(cors({
  origin: (origin, callback) => {
    // 允许没有origin的请求（比如移动应用或Postman）
    if (!origin) return callback(null, true)
    
    // 开发环境：允许所有localhost和127.0.0.1的请求
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true)
    }
    
    // 检查origin是否在允许列表中，或者是部署平台域名
    if (allowedOrigins.includes(origin) || 
        origin.includes('github.io') ||
        origin.includes('vercel.app') ||
        origin.includes('koyeb.app') ||
        origin.includes('eu.org') ||
        origin.includes('edgeone') ||
        origin.includes('pages.dev')) {
      callback(null, true)
    } else {
      console.log('❌ CORS阻止的请求来源:', origin)
      callback(new Error('不允许的跨域请求'))
    }
  },
  credentials: true
}))
// 紫夜流媒体代理（WHIP/WHEP）须在 json 解析之前，保留 SDP 原始 body
app.use('/api/ziye', express.raw({ type: () => true, limit: '2mb' }), ziyeRoutes)
app.use(express.json({ limit: '512kb' }))
app.use(express.urlencoded({ extended: true, limit: '512kb' }))
app.use(express.urlencoded({ extended: true }))

// 已持有合法 JWT 时：账号被删 / 会话被踢立即 401（防止删库管理员仍可操作）
app.use('/api', identityGateMiddleware)

// 影响导航徽章计数的写接口成功后立刻失效短缓存，避免审批后仍显示旧数字
const BADGE_MUTATION_PREFIXES = [
  '/api/leaves',
  '/api/reminders',
  '/api/assessment-applications',
  '/api/assessments',
  '/api/opinion-box',
  '/api/assistant',
  '/api/quit',
  '/api/retention',
  '/api/members',
  '/api/checkins',
]
app.use((req, res, next) => {
  const method = req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
  const path = req.path || ''
  if (!BADGE_MUTATION_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return next()
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 400) {
      invalidateBadgeCache()
    }
  })
  next()
})

// 路由
app.use('/api/auth', authRoutes)
app.use('/api/student', studentAuthRoutes)
app.use(
  '/api/members',
  requireAdminUnless([{ path: '/me', methods: ['GET'] }]),
  membersRoutes
)
app.use(
  '/api/leaves',
  requireAdminUnless([
    { path: '/my', methods: ['GET'] },
    { path: '/applications/my', methods: ['GET'] },
    { path: '/applications', methods: ['POST'] },
  ]),
  leavesRoutes
)
app.use('/api/blackpoints', requireAdminUnless([{ path: '/my', methods: ['GET'] }]), blackpointsRoutes)
app.use(
  '/api/reminders',
  requireAdminUnless([
    { path: '/attendance/me', methods: ['GET'] },
    { path: '/training/me', methods: ['GET'] },
  ]),
  remindersRoutes
)
app.use('/api/quit', ...adminGuard, quitRoutes)
app.use('/api/retention', ...adminGuard, retentionRoutes)
app.use(
  '/api/courses',
  requireAdminUnless([{ path: '/config/difficulties', methods: ['GET'] }]),
  coursesRoutes
)
app.use(
  '/api/progress',
  requireAdminUnless([{ path: '/my', methods: ['GET'] }]),
  progressRoutes
)
app.use('/api/settings', ...adminGuard, settingsRoutes)
app.use(
  '/api/assessments',
  requireAdminUnless([{ path: '/member', methods: ['GET'] }]),
  assessmentsRoutes
)
app.use(
  '/api/assessment-applications',
  requireAdminUnless([
    { path: '/', methods: ['POST'] },
    { path: '/member', methods: ['GET'] },
  ]),
  assessmentApplicationsRoutes
)
app.use(
  '/api/assessment-guidelines',
  requireAdminUnless([{ path: '/', methods: ['GET'] }]),
  assessmentGuidelinesRoutes
)
app.use(
  '/api/public-videos',
  requireAdminUnless([
    { path: '*', methods: ['GET'] },
    { path: '/', methods: ['POST'] },
  ]),
  publicVideosRoutes
)
app.use('/api/video-upload', ...adminGuard, videoUploadRoutes)
app.use('/api/classmates', classmatesRoutes)
app.use('/api/turn', turnRoutes)
app.use('/api/volc', volcRoutes)
app.use('/api/room', roomRoutes)
app.use('/api/meeting', meetingRoutes)
app.use('/api/versions', versionsRoutes)
app.use(
  '/api/duty',
  requireAdminUnless([{ path: '/today', methods: ['GET'] }]),
  dutyRoutes
)
app.use(
  '/api/docs',
  requireAdminUnless([
    { path: '/version', methods: ['GET'] },
    { path: '/list', methods: ['GET'] },
    { path: '/file', methods: ['GET'] },
    { path: '/index', methods: ['GET'] },
  ]),
  docsRoutes
)
app.use('/api/badges', ...adminGuard, badgesRoutes)
app.use('/api/anticheat', anticheatRoutes)
app.use('/api/surveys', surveysRoutes)
app.use('/api/sheets', sheetsRoutes)
app.use('/api/opinion-box', opinionBoxRoutes)
app.use('/api/account-security', accountSecurityRoutes)
app.use('/api/assistant', assistantRoutes)
app.use('/api/security', ...adminGuard, securityRoutes)
app.use('/api/checkins', checkinsRoutes)
app.use('/api/admin-ai', ...adminGuard, adminAiRoutes)

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '紫夜公会后端服务运行中' })
})

// 启动服务器（仅在本地开发时）
async function startServer() {
  // 测试数据库连接
  const dbConnected = await testConnection()
  
  if (!dbConnected) {
    console.error('⚠️  数据库连接失败，服务器启动中止')
    process.exit(1)
  }

  try {
    await ensureAdminRoleColumns()
    await ensureAuditLogTable()
    await ensureLoginOtpTable()
  } catch (e) {
    console.warn('安全相关表初始化失败:', e.message)
  }

  app.listen(PORT, () => {
    console.log(`🚀 服务器运行在端口 ${PORT}`)
    console.log(`📍 API地址: http://localhost:${PORT}/api`)
  })
}

// 检测是否在Vercel环境
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true'

// 仅在非Vercel环境（本地开发）下启动服务器
if (!isVercel) {
  startServer()

  const shutdown = async (signal) => {
    console.log(`\n${signal} 收到，正在关闭数据库连接池…`)
    try {
      await closePool()
    } finally {
      process.exit(0)
    }
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

// 导出app供Vercel使用
export default app
