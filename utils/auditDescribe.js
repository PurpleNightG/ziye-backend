/**
 * 把管理员写操作翻成可读摘要（审计「人话版」）
 */

const METHOD_VERB = {
  POST: '提交',
  PUT: '更新',
  PATCH: '修改',
  DELETE: '删除',
}

/** 资源域中文名 */
const RESOURCE_LABELS = [
  ['/api/leaves', '请假'],
  ['/api/reminders', '催更/考勤提醒'],
  ['/api/members', '队员'],
  ['/api/blackpoints', '黑点'],
  ['/api/quit', '退队'],
  ['/api/retention', '留队'],
  ['/api/courses', '课程'],
  ['/api/progress', '进度'],
  ['/api/settings', '系统设置'],
  ['/api/assessments', '考核'],
  ['/api/assessment-applications', '考核申请'],
  ['/api/assessment-guidelines', '考核须知'],
  ['/api/public-videos', '公开视频'],
  ['/api/video-upload', '视频上传'],
  ['/api/duty', '值班'],
  ['/api/docs', '文档'],
  ['/api/badges', '徽章'],
  ['/api/anticheat', '反作弊'],
  ['/api/surveys', '问卷'],
  ['/api/sheets', '表格'],
  ['/api/opinion-box', '意见箱'],
  ['/api/account-security', '账号安全'],
  ['/api/assistant', '助教'],
  ['/api/security', '安全中心'],
  ['/api/auth', '登录认证'],
  ['/api/meeting', '会议'],
  ['/api/room', '房间'],
  ['/api/classmates', '同学录'],
]

/**
 * 精确/模式匹配：method + 规范化路径 → 文案
 * :id 等已替换为 *
 */
const ACTION_RULES = [
  // 请假
  ['POST', '/api/leaves/auto-update', '自动更新请假状态（到期处理）'],
  ['POST', '/api/leaves/applications', '提交请假申请'],
  ['PUT', '/api/leaves/applications/*/review', '审核请假申请'],
  ['DELETE', '/api/leaves/applications/*', '删除请假申请'],
  ['POST', '/api/leaves', '新增请假记录'],
  ['PUT', '/api/leaves/*/end-approval', '审批提前结束请假'],
  ['PUT', '/api/leaves/*', '修改请假记录'],
  ['DELETE', '/api/leaves/*', '删除请假记录'],

  // 提醒
  ['POST', '/api/reminders/auto-update', '自动更新催更/考勤提醒状态'],
  ['PUT', '/api/reminders/attendance/batch/timeout', '批量设置考勤超时'],
  ['PUT', '/api/reminders/attendance/*/timeout', '设置考勤超时'],
  ['POST', '/api/reminders/attendance/ignore/*', '忽略考勤提醒'],
  ['DELETE', '/api/reminders/attendance/ignore/*', '取消忽略考勤提醒'],
  ['PUT', '/api/reminders/batch/timeout', '批量设置催更超时'],
  ['PUT', '/api/reminders/*/timeout', '设置催更超时'],
  ['DELETE', '/api/reminders/*', '删除催更提醒'],

  // 队员
  ['POST', '/api/members', '新增队员'],
  ['PUT', '/api/members/*', '修改队员信息'],
  ['DELETE', '/api/members/*', '删除队员'],

  // 黑点 / 退队 / 留队
  ['POST', '/api/blackpoints', '新增黑点'],
  ['PUT', '/api/blackpoints/*', '修改黑点'],
  ['DELETE', '/api/blackpoints/*', '删除黑点'],
  ['POST', '/api/quit/auto-generate', '自动生成退队记录'],
  ['POST', '/api/quit', '新增退队记录'],
  ['PUT', '/api/quit/*/approve', '审批退队'],
  ['DELETE', '/api/quit/*', '删除退队记录'],
  ['POST', '/api/retention', '新增留队记录'],
  ['PUT', '/api/retention/*', '修改留队记录'],
  ['DELETE', '/api/retention/*', '删除留队记录'],

  // 课程 / 进度 / 设置
  ['PUT', '/api/courses/order', '调整课程排序'],
  ['POST', '/api/courses/batch/delete', '批量删除课程'],
  ['PUT', '/api/courses/batch/update', '批量更新课程'],
  ['PUT', '/api/courses/config/categories', '更新课程分类配置'],
  ['PUT', '/api/courses/config/difficulties', '更新课程难度配置'],
  ['POST', '/api/courses', '新增课程'],
  ['PUT', '/api/courses/*', '修改课程'],
  ['DELETE', '/api/courses/*', '删除课程'],
  ['PUT', '/api/progress/*', '更新学习进度'],
  ['PUT', '/api/settings/*', '修改系统设置'],

  // 考核 / 视频
  ['POST', '/api/assessments/batch-delete', '批量删除考核'],
  ['POST', '/api/assessments', '新增考核'],
  ['PUT', '/api/assessments/*', '修改考核'],
  ['DELETE', '/api/assessments/*', '删除考核'],
  ['PUT', '/api/assessment-guidelines', '更新考核须知'],
  ['POST', '/api/public-videos/batch-delete', '批量删除公开视频'],
  ['POST', '/api/public-videos', '新增公开视频'],
  ['PUT', '/api/public-videos/*', '修改公开视频'],
  ['DELETE', '/api/public-videos/*', '删除公开视频'],
  ['POST', '/api/video-upload/upload', '上传视频文件'],
  ['POST', '/api/video-upload/import-drive', '从网盘导入视频'],
  ['DELETE', '/api/video-upload/delete/*', '删除已上传视频'],

  // 值班 / 徽章 / 文档
  ['POST', '/api/duty/clock-in', '值班打卡上班'],
  ['POST', '/api/duty/clock-out', '值班打卡下班'],
  ['POST', '/api/badges', '发放/创建徽章'],
  ['PUT', '/api/badges/*', '修改徽章'],
  ['DELETE', '/api/badges/*', '删除徽章'],
  ['PUT', '/api/docs/file', '更新文档文件'],
  ['DELETE', '/api/docs/file', '删除文档文件'],
  ['DELETE', '/api/docs/folder', '删除文档文件夹'],
  ['POST', '/api/docs/batch-rename', '批量重命名文档'],
  ['PUT', '/api/docs/visibility', '修改文档可见性'],
  ['PUT', '/api/docs/order', '调整文档排序'],

  // 反作弊
  ['POST', '/api/anticheat/tickets/import/batch', '批量导入反作弊考核券'],
  ['POST', '/api/anticheat/tickets/import', '导入反作弊考核券'],
  ['PATCH', '/api/anticheat/configs/*', '修改反作弊考核配置'],
  ['POST', '/api/anticheat/configs/*/reactivate', '重新启用反作弊配置'],
  ['DELETE', '/api/anticheat/configs/*', '删除反作弊配置'],
  ['POST', '/api/anticheat/configs/batch-delete', '批量删除反作弊配置'],
  ['POST', '/api/anticheat/configs/*/mods', '为配置添加模组'],
  ['DELETE', '/api/anticheat/mods/*', '删除反作弊模组'],
  ['POST', '/api/anticheat/mods/batch-delete', '批量删除模组'],
  ['POST', '/api/anticheat/sessions/*/end', '结束反作弊考核会话'],
  ['POST', '/api/anticheat/sessions/*/terminate', '强制终止考核会话'],
  ['DELETE', '/api/anticheat/sessions/*', '删除考核会话'],
  ['POST', '/api/anticheat/sessions/batch-end', '批量结束考核会话'],
  ['POST', '/api/anticheat/sessions/batch-terminate', '批量强制终止考核会话'],
  ['POST', '/api/anticheat/sessions/batch-delete', '批量删除考核会话'],
  ['POST', '/api/anticheat/screenshots/reclaim-space', '回收截图存储空间'],
  ['POST', '/api/anticheat/sessions/*/request-screenshot', '请求考核截图'],
  ['POST', '/api/anticheat/sessions/batch-request-screenshot', '批量请求考核截图'],
  ['PUT', '/api/anticheat/settings', '更新反作弊设置'],
  ['POST', '/api/anticheat/dll-whitelist', '添加 DLL 白名单'],
  ['DELETE', '/api/anticheat/dll-whitelist/*', '删除 DLL 白名单项'],

  // 问卷 / 表格 / 意见箱
  ['POST', '/api/surveys', '创建问卷'],
  ['PUT', '/api/surveys/*', '修改问卷'],
  ['DELETE', '/api/surveys/*/responses/*', '删除问卷答卷'],
  ['DELETE', '/api/surveys/*', '删除问卷'],
  ['POST', '/api/sheets/*/copy', '复制表格'],
  ['POST', '/api/sheets/*/revisions/*/restore', '恢复表格历史版本'],
  ['POST', '/api/sheets', '创建表格'],
  ['PUT', '/api/sheets/*', '修改表格'],
  ['DELETE', '/api/sheets/*', '删除表格'],
  ['PATCH', '/api/opinion-box/*', '处理意见箱留言'],
  ['DELETE', '/api/opinion-box/*', '删除意见箱留言'],

  // 安全中心 / 认证
  ['POST', '/api/security/admins/*/revoke-sessions', '强制登出管理员全部会话'],
  ['POST', '/api/security/sessions/*/revoke', '强制登出指定会话'],
  ['PUT', '/api/security/admins/*/email', '绑定/修改管理员邮箱'],
  ['POST', '/api/security/admins', '创建管理员账号'],
  ['PUT', '/api/security/admins/*/super', '变更超级管理员权限'],
  ['PUT', '/api/security/admins/*/login-disabled', '禁止/恢复管理员登录'],
  ['DELETE', '/api/security/admins/*', '删除管理员账号'],
  ['POST', '/api/auth/login/verify-otp', '管理员登录成功（验证码）'],
  ['POST', '/api/auth/login/send-otp', '发送登录验证码'],
  ['PUT', '/api/auth/change-password', '修改登录密码'],

  // 账号安全
  ['PUT', '/api/account-security/password', '修改账号密码'],
  ['PUT', '/api/account-security/avatar', '更新头像'],
  ['POST', '/api/account-security/logout', '退出登录'],
  ['POST', '/api/account-security/sessions/*/logout', '登出指定会话'],
  ['DELETE', '/api/account-security/sessions/others', '登出其它设备'],
  ['DELETE', '/api/account-security/sessions/*', '删除登录会话'],

  // 助教管理（常见）
  ['PUT', '/api/assistant/admin/*/permissions', '修改助教权限'],
  ['POST', '/api/assistant/admin/*/enable', '启用助教'],
  ['POST', '/api/assistant/admin/*/disable', '停用助教'],
  ['POST', '/api/assistant/admin/assignments', '分配助教学员'],
  ['DELETE', '/api/assistant/admin/assignments/*', '取消助教分配'],
  ['PUT', '/api/assistant/admin/assignments/*/review', '审核助教分配申请'],
  ['PUT', '/api/assistant/admin/member-creates/*/review', '审核新建队员申请'],
  ['PUT', '/api/assistant/admin/stage-promotions/*/review', '审核阶段晋升申请'],
  ['PUT', '/api/assistant/admin/member-edits/*/review', '审核队员信息修改申请'],
  ['PUT', '/api/assistant/admin/black-points/*/review', '审核黑点申请'],
  ['PUT', '/api/assistant/admin/leaves/*/review', '审核请假申请（助教）'],
  ['POST', '/api/assistant/admin/daily-assignments', '设置每日助教任务'],
  ['DELETE', '/api/assistant/admin/daily-assignments/*', '删除每日助教任务'],
]

function normalizePath(path) {
  const raw = String(path || '').split('?')[0]
  return raw
    .replace(/\/\d+/g, '/*')
    .replace(/\/[0-9a-f]{8,}(?:-[0-9a-f]{4,})+/gi, '/*')
    .replace(/\/+$/, '') || '/'
}

function matchRule(method, path) {
  const m = String(method || '').toUpperCase()
  const p = normalizePath(path)
  for (const [rm, rp, text] of ACTION_RULES) {
    if (rm !== m) continue
    if (rp === p) return text
    // 允许末尾多一段 *
    if (rp.endsWith('/*') && (p === rp.slice(0, -2) || p.startsWith(rp.slice(0, -1)))) {
      return text
    }
  }
  return null
}

function resourceLabel(path) {
  const p = String(path || '').split('?')[0]
  for (const [prefix, label] of RESOURCE_LABELS) {
    if (p === prefix || p.startsWith(prefix + '/')) return label
  }
  return null
}

function pickHints(body, params) {
  const src = { ...(params || {}), ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) }
  const bits = []
  const keys = [
    ['name', '名称'],
    ['username', '用户名'],
    ['title', '标题'],
    ['member_name', '队员'],
    ['memberName', '队员'],
    ['student_name', '学员'],
    ['key', '键'],
    ['status', '状态'],
    ['id', 'ID'],
    ['member_id', '队员ID'],
    ['memberId', '队员ID'],
  ]
  for (const [k, label] of keys) {
    if (src[k] == null || src[k] === '') continue
    const v = String(src[k]).slice(0, 40)
    bits.push(`${label}=${v}`)
    if (bits.length >= 3) break
  }
  return bits
}

/** 摘要是否已经是「人话」（不是纯 METHOD /api/...） */
export function isTechnicalSummary(summary) {
  if (!summary) return true
  return /^(GET|POST|PUT|PATCH|DELETE)\s+\/api\//i.test(String(summary).trim())
}

/**
 * @returns {{ tech: string, human: string }}
 */
export function describeAdminAction({
  method,
  path,
  body = null,
  params = null,
  existingSummary = null,
}) {
  const cleanPath = String(path || '').split('?')[0]
  const tech = `${method || ''} ${cleanPath}`.trim()

  if (existingSummary && !isTechnicalSummary(existingSummary)) {
    return { tech, human: String(existingSummary).slice(0, 500) }
  }

  const matched = matchRule(method, cleanPath)
  const hints = pickHints(body, params)
  if (matched) {
    const human = hints.length ? `${matched}（${hints.join('，')}）` : matched
    return { tech, human: human.slice(0, 500) }
  }

  const verb = METHOD_VERB[String(method || '').toUpperCase()] || '操作'
  const res = resourceLabel(cleanPath) || '管理数据'
  const idMatch = cleanPath.match(/\/(\d+)(?:\/|$)/)
  const idBit = idMatch ? ` #${idMatch[1]}` : ''
  const hintBit = hints.length ? `（${hints.join('，')}）` : ''
  const human = `${verb}${res}${idBit}${hintBit}`.slice(0, 500)
  return { tech, human }
}

/** 列表展示：优先用人话摘要，旧数据按路径现场翻译 */
export function resolveAuditDisplay(row) {
  const { tech, human } = describeAdminAction({
    method: row.method,
    path: row.path,
    existingSummary: row.summary,
  })
  return {
    summary_tech: tech || `${row.method || ''} ${row.path || ''}`.trim(),
    summary_human: human || row.summary || row.action || tech,
  }
}
