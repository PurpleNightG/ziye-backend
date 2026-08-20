import express from 'express'
import jwt from 'jsonwebtoken'
import { pool } from '../config/database.js'
import { requireAdmin, requireStudent, assertIdentityValid } from '../utils/authGate.js'
import { assertSessionActive, touchSession } from '../utils/loginSessions.js'
import { isZiyeAssistantMember } from '../utils/assistantConstants.js'
import { toMySQLDate } from '../utils/date.js'
import { resolveEffectiveClientIpAsync } from '../utils/clientIp.js'
import {
  ensureCheckinTables,
  shanghaiToday,
  getOrCreateTodayDay,
  getDayByDate,
  getDayById,
  regenerateCode,
  stopDay,
  countRecords,
  listRecords,
  listRecentDays,
  studentSelfCheckin,
  getMemberCheckinStatus,
  buildActivitySummary,
  cancelCheckinRecord,
  getStudentAttemptInfo,
} from '../utils/checkinService.js'

const router = express.Router()
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

async function requireAssistant(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ success: false, message: '未登录' })
    const decoded = jwt.verify(token, JWT_SECRET)
    if (decoded.role !== 'student' && decoded.userType !== 'student') {
      return res.status(403).json({ success: false, message: '需要助教登录' })
    }
    const active = await assertSessionActive(decoded)
    if (!active) return res.status(401).json({ success: false, message: '会话已失效，请重新登录' })
    if (!(await assertIdentityValid(decoded))) {
      return res.status(401).json({ success: false, message: '账号已不存在，请重新登录' })
    }
    void touchSession(decoded.jti)
    const [[member]] = await pool.query(
      `SELECT id, nickname, qq, stage_role, status, is_assistant, is_ziye_assistant
       FROM members WHERE id = ?`,
      [decoded.id]
    )
    if (!member || member.status === '已退队') {
      return res.status(403).json({ success: false, message: '账号不可用' })
    }
    if (!isZiyeAssistantMember(member)) {
      return res.status(403).json({ success: false, message: '需要紫夜助教身份' })
    }
    req.assistant = member
    next()
  } catch (e) {
    return res.status(401).json({ success: false, message: '登录无效' })
  }
}

function adminActor(req) {
  const u = req.admin || req.user || {}
  return {
    id: u.id,
    name: u.name || u.username || '管理员',
  }
}

async function dayPayload(day) {
  if (!day) return null
  const checked_count = await countRecords(day.id)
  return {
    id: day.id,
    checkin_date: day.checkin_date,
    code: day.code,
    status: day.status,
    created_by_name: day.created_by_name,
    stopped_by_name: day.stopped_by_name,
    stopped_at: day.stopped_at,
    checked_count,
  }
}

router.use(async (_req, _res, next) => {
  try {
    await ensureCheckinTables()
  } catch (e) {
    console.warn('[checkin] ensure tables', e.message)
  }
  next()
})

/** 管理：今日任务（无则创建） */
router.get('/admin/today', requireAdmin, async (req, res) => {
  try {
    const day = await getOrCreateTodayDay(adminActor(req))
    const records = await listRecords(day.id)
    res.json({
      success: true,
      data: {
        day: await dayPayload(day),
        records,
        today: shanghaiToday(),
      },
    })
  } catch (e) {
    console.error('[checkin] admin today', e)
    res.status(500).json({ success: false, message: '获取签到任务失败' })
  }
})

/** 管理：更换签到码 */
router.post('/admin/today/regenerate', requireAdmin, async (req, res) => {
  try {
    const day = await getOrCreateTodayDay(adminActor(req))
    const updated = await regenerateCode(day.id, adminActor(req))
    res.json({
      success: true,
      message: '已生成新签到码',
      data: { day: await dayPayload(updated) },
    })
  } catch (e) {
    console.error('[checkin] regenerate', e)
    res.status(500).json({ success: false, message: '更换签到码失败' })
  }
})

/** 管理：停止当日签到（未开训） */
router.post('/admin/today/stop', requireAdmin, async (req, res) => {
  try {
    const day = await getOrCreateTodayDay(adminActor(req))
    const updated = await stopDay(day.id, adminActor(req))
    res.json({
      success: true,
      message: '已停止今日签到（记为未开训）',
      data: { day: await dayPayload(updated) },
    })
  } catch (e) {
    console.error('[checkin] stop', e)
    res.status(500).json({ success: false, message: '停止签到失败' })
  }
})

/** 管理：按日期查看 */
router.get('/admin/days/:date', requireAdmin, async (req, res) => {
  try {
    const date = toMySQLDate(req.params.date)
    if (!date) return res.status(400).json({ success: false, message: '日期无效' })
    const day = await getDayByDate(date)
    if (!day) return res.json({ success: true, data: { day: null, records: [] } })
    res.json({
      success: true,
      data: {
        day: await dayPayload(day),
        records: await listRecords(day.id),
      },
    })
  } catch (e) {
    console.error('[checkin] admin day', e)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.get('/admin/history', requireAdmin, async (req, res) => {
  try {
    const rows = await listRecentDays(Number(req.query.limit) || 30)
    res.json({ success: true, data: rows })
  } catch (e) {
    console.error('[checkin] history', e)
    res.status(500).json({ success: false, message: '获取历史失败' })
  }
})

router.get('/admin/activity-summary', requireAdmin, async (req, res) => {
  try {
    const data = await buildActivitySummary({ days: Number(req.query.days) || 14 })
    res.json({ success: true, data })
  } catch (e) {
    console.error('[checkin] activity', e)
    res.status(500).json({ success: false, message: '汇总失败' })
  }
})

/** 管理：取消某条签到（测试/纠错）；按规则回退最后新训日期 */
router.post('/admin/records/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const result = await cancelCheckinRecord(req.params.id)
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, message: result.message })
    }
    const d = result.data
    let message = `已取消 ${d.member_name || '成员'} 在 ${d.cancelled_date} 的签到`
    if (d.date_changed) {
      message += d.last_training_date
        ? `，最后新训日期已回退为 ${d.last_training_date}`
        : '，最后新训日期已清空'
    } else {
      message += '（该成员最后新训日期已非当日，未改动日期）'
    }
    res.json({ success: true, message, data: d })
  } catch (e) {
    console.error('[checkin] cancel', e)
    res.status(500).json({ success: false, message: '取消签到失败' })
  }
})

/** 助教：只读今日 */
router.get('/assistant/today', requireAssistant, async (_req, res) => {
  try {
    const today = shanghaiToday()
    const day = await getDayByDate(today)
    if (!day) {
      return res.json({
        success: true,
        data: { day: null, records: [], today, message: '管理端尚未开启今日签到' },
      })
    }
    res.json({
      success: true,
      data: {
        day: await dayPayload(day),
        records: await listRecords(day.id),
        today,
      },
    })
  } catch (e) {
    console.error('[checkin] assistant today', e)
    res.status(500).json({ success: false, message: '获取签到任务失败' })
  }
})

router.get('/assistant/days/:date', requireAssistant, async (req, res) => {
  try {
    const date = toMySQLDate(req.params.date)
    if (!date) return res.status(400).json({ success: false, message: '日期无效' })
    const day = await getDayByDate(date)
    if (!day) return res.json({ success: true, data: { day: null, records: [] } })
    res.json({
      success: true,
      data: {
        day: await dayPayload(day),
        records: await listRecords(day.id),
      },
    })
  } catch (e) {
    console.error('[checkin] assistant day', e)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.get('/assistant/history', requireAssistant, async (req, res) => {
  try {
    const rows = await listRecentDays(Number(req.query.limit) || 30)
    res.json({ success: true, data: rows })
  } catch (e) {
    console.error('[checkin] assistant history', e)
    res.status(500).json({ success: false, message: '获取历史失败' })
  }
})

/** 学员：今日状态 */
router.get('/student/today', requireStudent, async (req, res) => {
  try {
    const memberId = req.student?.id || req.user?.id
    const [[member]] = await pool.query(
      `SELECT id, nickname, status, last_training_date FROM members WHERE id = ?`,
      [memberId]
    )
    if (!member) return res.status(404).json({ success: false, message: '成员不存在' })
    const today = shanghaiToday()
    const day = await getDayByDate(today)
    const status = await getMemberCheckinStatus(memberId, today)
    const attempt = await getStudentAttemptInfo(memberId, today)
    res.json({
      success: true,
      data: {
        today,
        day: day
          ? {
              checkin_date: day.checkin_date,
              status: day.status,
              // 不把签到码返回给学员
            }
          : null,
        checked: status.checked,
        record: status.record,
        last_training_date: member.last_training_date,
        attempt,
      },
    })
  } catch (e) {
    console.error('[checkin] student today', e)
    res.status(500).json({ success: false, message: '获取签到状态失败' })
  }
})

/** 学员：提交签到码 */
router.post('/student/submit', requireStudent, async (req, res) => {
  try {
    const memberId = req.student?.id || req.user?.id
    const [[member]] = await pool.query(
      `SELECT id, nickname, username, status FROM members WHERE id = ?`,
      [memberId]
    )
    if (!member) return res.status(404).json({ success: false, message: '成员不存在' })
    const clientIp = await resolveEffectiveClientIpAsync(req, req.body?.clientPublicIp)
    const result = await studentSelfCheckin(member, req.body?.code, { clientIp })
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
        data: result.data || null,
      })
    }
    res.json({ success: true, message: '签到成功', data: result.data })
  } catch (e) {
    console.error('[checkin] student submit', e)
    res.status(500).json({ success: false, message: '签到失败' })
  }
})

export default router
