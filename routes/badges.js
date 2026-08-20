import express from 'express'
import { pool } from '../config/database.js'
import { computeAttendanceForMember } from '../utils/attendanceReminder.js'
import { countTrainingReminders } from '../utils/trainingReminderList.js'
import { loadFormalAttendancePolicy } from '../utils/formalAttendancePolicy.js'

const router = express.Router()

/** 进程内短缓存，避免管理端轮询反复扫全表；写操作后必须 invalidate */
const BADGE_CACHE_TTL_MS = 60_000
let badgeCache = { at: 0, data: null }
let badgeInflight = null
let badgeCacheEpoch = 0

/** 审批/名单变更后立刻失效，避免导航徽章仍显示旧计数 */
export function invalidateBadgeCache() {
  badgeCacheEpoch += 1
  badgeCache = { at: 0, data: null }
  badgeInflight = null
}

async function computeBadges() {
  let leavePending = 0
  let leaveEndPending = 0
  let assessmentPending = 0
  let opinionPending = 0
  let reminderCount = 0
  let attendanceReminderCount = 0
  let assistantPending = 0

  try {
    const [[row]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM leave_applications la
          INNER JOIN members m ON m.id = la.member_id AND m.status != '已退队'
          WHERE la.status = '待审批') AS leave_pending,
        (SELECT COUNT(*) FROM leave_records lr
          INNER JOIN members m ON m.id = lr.member_id AND m.status != '已退队'
          WHERE lr.status = '待结束审批') AS leave_end_pending,
        (SELECT COUNT(*) FROM assessment_applications aa
          INNER JOIN members m ON m.id = aa.member_id AND m.status != '已退队'
          WHERE aa.status = '待审批') AS assessment_pending,
        (SELECT COUNT(*) FROM opinion_box WHERE status = 'pending') AS opinion_pending
    `)
    leavePending = Number(row.leave_pending) || 0
    leaveEndPending = Number(row.leave_end_pending) || 0
    assessmentPending = Number(row.assessment_pending) || 0
    opinionPending = Number(row.opinion_pending) || 0
  } catch (e) {
    console.error('[badges] pending counts query failed:', e.message)
    // opinion_box 可能尚未建表：其余三项再分别兜底
    try {
      const [[a]] = await pool.query(`
        SELECT COUNT(*) AS cnt FROM leave_applications la
        INNER JOIN members m ON m.id = la.member_id AND m.status != '已退队'
        WHERE la.status = '待审批'`)
      leavePending = Number(a.cnt) || 0
    } catch { /* ignore */ }
    try {
      const [[b]] = await pool.query(`
        SELECT COUNT(*) AS cnt FROM leave_records lr
        INNER JOIN members m ON m.id = lr.member_id AND m.status != '已退队'
        WHERE lr.status = '待结束审批'`)
      leaveEndPending = Number(b.cnt) || 0
    } catch { /* ignore */ }
    try {
      const [[c]] = await pool.query(`
        SELECT COUNT(*) AS cnt FROM assessment_applications aa
        INNER JOIN members m ON m.id = aa.member_id AND m.status != '已退队'
        WHERE aa.status = '待审批'`)
      assessmentPending = Number(c.cnt) || 0
    } catch { /* ignore */ }
  }

  try {
    const { count } = await countTrainingReminders()
    reminderCount = count
  } catch (e) {
    console.error('[badges] reminder count query failed:', e.message)
  }

  try {
    const [members] = await pool.query(`
      SELECT
        m.id, m.nickname, m.qq, m.stage_role, m.status,
        m.join_date, m.last_training_date, m.phase3_reached_at,
        CASE WHEN ret.id IS NOT NULL THEN 1 ELSE 0 END AS in_retention
      FROM members m
      LEFT JOIN retention_records ret ON m.id = ret.member_id
      WHERE m.status NOT IN ('已退队', '请假中', '其他')
    `)
    const [leaves] = await pool.query(`
      SELECT member_id, start_date, end_date, status
      FROM leave_records
      WHERE status IN ('请假中', '待结束审批', '已结束')
    `)
    const leaveMap = new Map()
    for (const row of leaves) {
      if (!leaveMap.has(row.member_id)) leaveMap.set(row.member_id, [])
      leaveMap.get(row.member_id).push(row)
    }
    const [ignores] = await pool.query('SELECT member_id FROM attendance_reminder_ignores')
    const ignoreSet = new Set(ignores.map((r) => r.member_id))
    const { formalTimeoutDays, use180Set, rulesConfig } = await loadFormalAttendancePolicy()
    for (const m of members) {
      const item = computeAttendanceForMember(m, leaveMap.get(m.id) || [], {
        ignored: ignoreSet.has(m.id),
        inRetention: !!m.in_retention,
        showAll: false,
        formalTimeoutDays,
        useFormal180: use180Set.has(Number(m.id)),
        rulesConfig,
      })
      if (item) attendanceReminderCount++
    }
  } catch (e) {
    console.error('[badges] attendance reminder count failed:', e.message)
  }

  try {
    const [[row]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM assistant_student_assignments WHERE status = '待审批') +
        (SELECT COUNT(*) FROM pending_member_creates WHERE status = '待审批') +
        (SELECT COUNT(*) FROM pending_stage_promotions WHERE status = '待审批') +
        (SELECT COUNT(*) FROM pending_member_edits WHERE status = '待审批') +
        (SELECT COUNT(*) FROM pending_black_points WHERE status = '待审批') +
        (SELECT COUNT(*) FROM pending_leaves WHERE status = '待审批') AS cnt
    `)
    assistantPending = Number(row.cnt) || 0
  } catch (e) {
    console.error('[badges] assistant pending query failed:', e.message)
  }

  return {
    leavePending,
    leaveEndPending,
    assessmentPending,
    opinionPending,
    assistantPending,
    reminderCount: reminderCount + attendanceReminderCount,
    trainingReminderCount: reminderCount,
    attendanceReminderCount,
  }
}

async function getBadgeData({ forceFresh = false } = {}) {
  if (forceFresh) {
    invalidateBadgeCache()
    const epoch = badgeCacheEpoch
    const data = await computeBadges()
    if (epoch === badgeCacheEpoch) {
      badgeCache = { at: Date.now(), data }
    }
    return { data, cached: false }
  }

  const now = Date.now()
  if (badgeCache.data && now - badgeCache.at < BADGE_CACHE_TTL_MS) {
    return { data: badgeCache.data, cached: true }
  }

  if (!badgeInflight) {
    const epoch = badgeCacheEpoch
    badgeInflight = computeBadges()
      .then((data) => {
        if (epoch === badgeCacheEpoch) {
          badgeCache = { at: Date.now(), data }
        }
        return data
      })
      .finally(() => {
        badgeInflight = null
      })
  }
  const data = await badgeInflight
  return { data: badgeCache.data || data, cached: false }
}

// 获取导航栏待办数量；?fresh=1 强制重算（前端审批后 refresh 用）
router.get('/', async (req, res) => {
  try {
    const forceFresh =
      req.query.fresh === '1' ||
      req.query.fresh === 'true' ||
      String(req.headers['x-badge-fresh'] || '') === '1'

    const { data, cached } = await getBadgeData({ forceFresh })
    res.json({ success: true, data, ...(cached ? { cached: true } : {}) })
  } catch (e) {
    console.error('[badges]', e)
    res.status(500).json({ success: false, message: '获取徽章失败' })
  }
})

export default router
