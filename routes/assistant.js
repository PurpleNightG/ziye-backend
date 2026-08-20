import express from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { pool } from '../config/database.js'
import { toMySQLDate } from '../utils/date.js'
import { ensurePhase3ReachedAt, computeAttendanceForMember, ATTENDANCE_WARN_DAYS } from '../utils/attendanceReminder.js'
import { loadFormalAttendancePolicy } from '../utils/formalAttendancePolicy.js'
import { TRAINING_WARN_DAYS } from '../utils/reminderQuery.js'
import { loadReminderConfig, queryTrainingReminders } from '../utils/trainingReminderList.js'
import { computeStageFromCourseProgress, STAGE_SYNC_SKIP_ROLES } from '../utils/stageFromProgress.js'
import {
  ASSISTANT_ROLE,
  TRAINING_ROSTER_STAGES,
  DIRECT_STAGE_ALLOWED,
  needsStageApproval,
  isZiyeAssistantMember,
  DEFAULT_ASSISTANT_PERMISSIONS,
  mergePermissions,
} from '../utils/assistantConstants.js'
import { clearAssistantRoleData, cleanupOrphanedAssistantData } from '../utils/clearAssistantData.js'
import { requireAdmin, assertIdentityValid } from '../utils/authGate.js'
import { assertSessionActive, touchSession } from '../utils/loginSessions.js'

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
      `SELECT id, nickname, qq, stage_role, status, is_assistant, is_ziye_assistant,
              screen_share_enabled, screen_share_quota, screen_share_used, guest_code_max
       FROM members WHERE id = ?`,
      [decoded.id]
    )
    if (!member || member.status === '已退队') {
      return res.status(403).json({ success: false, message: '账号不可用' })
    }
    if (!isZiyeAssistantMember(member)) {
      return res.status(403).json({ success: false, message: '需要紫夜助教身份' })
    }
    const [[permRow]] = await pool.query(
      'SELECT permissions_json FROM assistant_permissions WHERE assistant_member_id = ?',
      [member.id]
    )
    req.assistant = member
    req.permissions = mergePermissions(permRow?.permissions_json)
    next()
  } catch {
    return res.status(401).json({ success: false, message: '认证令牌无效或已过期' })
  }
}

function requirePerm(key) {
  return (req, res, next) => {
    if (!req.permissions?.[key]) {
      return res.status(403).json({ success: false, message: '无此权限' })
    }
    next()
  }
}

function shanghaiToday() {
  return (
    toMySQLDate(new Date()) ||
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  )
}

/** 长期归属 */
async function isPermanentStudent(assistantId, studentId) {
  const [rows] = await pool.query(
    `SELECT id FROM assistant_student_assignments
     WHERE assistant_member_id = ? AND student_member_id = ? AND status = '已通过'`,
    [assistantId, studentId]
  )
  return rows.length > 0
}

/** 当日临时学员（上海日历日，过零点自动失效） */
async function isDailyStudent(assistantId, studentId) {
  const today = shanghaiToday()
  const [rows] = await pool.query(
    `SELECT id FROM assistant_daily_assignments
     WHERE assistant_member_id = ? AND student_member_id = ? AND assign_date = ?`,
    [assistantId, studentId, today]
  )
  return rows.length > 0
}

/** 助教可管理：长期归属 或 当日临时 */
async function isAssignedStudent(assistantId, studentId) {
  if (await isPermanentStudent(assistantId, studentId)) return true
  return isDailyStudent(assistantId, studentId)
}

async function getAssignedStudentIds(assistantId) {
  const today = shanghaiToday()
  const [perm] = await pool.query(
    `SELECT student_member_id AS id FROM assistant_student_assignments
     WHERE assistant_member_id = ? AND status = '已通过'`,
    [assistantId]
  )
  const [daily] = await pool.query(
    `SELECT student_member_id AS id FROM assistant_daily_assignments
     WHERE assistant_member_id = ? AND assign_date = ?`,
    [assistantId, today]
  )
  return [...new Set([...perm, ...daily].map((r) => Number(r.id)))]
}

async function getPermissionsFor(assistantId) {
  const [[permRow]] = await pool.query(
    'SELECT permissions_json FROM assistant_permissions WHERE assistant_member_id = ?',
    [assistantId]
  )
  return mergePermissions(permRow?.permissions_json)
}

/** 与 /api/room/assistants/:id 对齐：开关屏幕共享助教及配额等字段 */
async function syncScreenShareSettings(assistantId, enabled, settings = {}) {
  if (!enabled) {
    await pool.query(`UPDATE members SET is_assistant = 0 WHERE id = ?`, [assistantId])
    return
  }

  const [[member]] = await pool.query(
    `SELECT is_assistant, screen_share_enabled, screen_share_quota, screen_share_used, guest_code_max
     FROM members WHERE id = ?`,
    [assistantId]
  )
  if (!member) return

  const nextEnabled =
    settings.screen_share_enabled !== undefined
      ? !!settings.screen_share_enabled
      : member.is_assistant
        ? !!member.screen_share_enabled
        : true

  let nextQuota = member.screen_share_quota
  if (settings.screen_share_quota !== undefined) {
    nextQuota =
      settings.screen_share_quota === null || settings.screen_share_quota === ''
        ? null
        : Math.max(0, parseInt(settings.screen_share_quota, 10) || 0)
  } else if (!member.is_assistant) {
    nextQuota = null
  }

  let nextGuestMax = Number(member.guest_code_max) || 1
  if (settings.guest_code_max !== undefined) {
    nextGuestMax = Math.max(0, parseInt(settings.guest_code_max, 10) || 0)
  } else if (!member.is_assistant) {
    nextGuestMax = 1
  }

  let nextUsed = Number(member.screen_share_used) || 0
  if (settings.reset_used) {
    nextUsed = 0
  } else if (!member.is_assistant) {
    nextUsed = 0
  }

  await pool.query(
    `UPDATE members SET
      is_assistant = 1,
      screen_share_enabled = ?,
      screen_share_quota = ?,
      screen_share_used = ?,
      guest_code_max = ?
     WHERE id = ?`,
    [nextEnabled ? 1 : 0, nextQuota, nextUsed, nextGuestMax, assistantId]
  )
}

// ─── 助教端 ─────────────────────────────────────────────

router.get('/me', requireAssistant, async (req, res) => {
  res.json({
    success: true,
    data: {
      member: {
        id: req.assistant.id,
        nickname: req.assistant.nickname,
        qq: req.assistant.qq,
        stage_role: req.assistant.stage_role,
        is_ziye_assistant: req.assistant.is_ziye_assistant,
      },
      permissions: req.permissions,
    },
  })
})

router.get('/roster', requireAssistant, requirePerm('view_training_roster'), async (req, res) => {
  try {
    const placeholders = TRAINING_ROSTER_STAGES.map(() => '?').join(',')
    const aid = req.assistant.id
    const [rows] = await pool.query(
      `SELECT m.id, m.nickname, m.qq, m.stage_role, m.join_date, m.last_training_date, m.avatar, m.status,
              my.id AS assignment_id,
              my.status AS assignment_status,
              (
                SELECT JSON_ARRAYAGG(j.o)
                FROM (
                  SELECT JSON_OBJECT(
                    'id', am.id,
                    'nickname', am.nickname,
                    'avatar', am.avatar,
                    'qq', am.qq
                  ) AS o
                  FROM assistant_student_assignments a
                  INNER JOIN members am ON am.id = a.assistant_member_id
                  WHERE a.student_member_id = m.id AND a.status = '已通过'
                  ORDER BY a.updated_at DESC
                ) j
              ) AS owners_json,
              (
                SELECT JSON_ARRAYAGG(j.o)
                FROM (
                  SELECT JSON_OBJECT(
                    'id', am.id,
                    'nickname', am.nickname,
                    'avatar', am.avatar,
                    'qq', am.qq
                  ) AS o
                  FROM assistant_student_assignments a
                  INNER JOIN members am ON am.id = a.assistant_member_id
                  WHERE a.student_member_id = m.id AND a.status = '待审批'
                  ORDER BY a.created_at DESC
                ) j
              ) AS pending_owners_json
       FROM members m
       LEFT JOIN assistant_student_assignments my
         ON my.student_member_id = m.id AND my.assistant_member_id = ?
       WHERE m.status != '已退队' AND m.stage_role IN (${placeholders})
       ORDER BY m.join_date DESC`,
      [aid, ...TRAINING_ROSTER_STAGES]
    )

    const parseJsonArr = (v) => {
      if (!v) return []
      if (Array.isArray(v)) return v
      try {
        const parsed = typeof v === 'string' ? JSON.parse(v) : v
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }

    const data = rows.map((r) => {
      const { owners_json, pending_owners_json, ...rest } = r
      const owners = parseJsonArr(owners_json)
      const pendingOwners = parseJsonArr(pending_owners_json)
      return {
        ...rest,
        owners,
        pending_owners: pendingOwners,
        owner_assistant_names: owners.map((o) => o.nickname).filter(Boolean).join('、') || null,
        owner_assistant_id: owners[0]?.id ?? null,
        pending_assistant_names: pendingOwners.map((o) => o.nickname).filter(Boolean).join('、') || null,
      }
    })

    res.json({ success: true, data })
  } catch (error) {
    console.error('助教花名册失败:', error)
    res.status(500).json({ success: false, message: '获取花名册失败' })
  }
})

router.get('/students', requireAssistant, async (req, res) => {
  try {
    const today = shanghaiToday()
    const [perm] = await pool.query(
      `SELECT m.id, m.nickname, m.qq, m.stage_role, m.join_date, m.last_training_date,
              m.phase3_reached_at, m.avatar, m.status,
              a.id AS assignment_id, a.created_at AS assigned_at,
              0 AS is_daily, NULL AS daily_assign_date
       FROM assistant_student_assignments a
       INNER JOIN members m ON m.id = a.student_member_id
       WHERE a.assistant_member_id = ? AND a.status = '已通过' AND m.status != '已退队'
       ORDER BY a.updated_at DESC`,
      [req.assistant.id]
    )
    const permIds = new Set(perm.map((r) => Number(r.id)))
    const [daily] = await pool.query(
      `SELECT m.id, m.nickname, m.qq, m.stage_role, m.join_date, m.last_training_date,
              m.phase3_reached_at, m.avatar, m.status,
              d.id AS assignment_id, d.created_at AS assigned_at,
              1 AS is_daily, d.assign_date AS daily_assign_date
       FROM assistant_daily_assignments d
       INNER JOIN members m ON m.id = d.student_member_id
       WHERE d.assistant_member_id = ? AND d.assign_date = ? AND m.status != '已退队'
       ORDER BY d.created_at DESC`,
      [req.assistant.id, today]
    )
    const merged = [
      ...perm.map((r) => ({ ...r, is_daily: false })),
      ...daily.filter((r) => !permIds.has(Number(r.id))).map((r) => ({ ...r, is_daily: true })),
    ]
    res.json({ success: true, data: merged, meta: { today } })
  } catch (error) {
    console.error('助教学员列表失败:', error)
    res.status(500).json({ success: false, message: '获取学员失败' })
  }
})

/** 直接更新最后新训日期（长期 / 当日临时均可） */
router.put('/students/:id/last-training-date', requireAssistant, async (req, res) => {
  try {
    const studentId = Number(req.params.id)
    const date = toMySQLDate(req.body?.last_training_date || shanghaiToday())
    if (!date) return res.status(400).json({ success: false, message: '日期无效' })
    if (!(await isAssignedStudent(req.assistant.id, studentId))) {
      return res.status(403).json({ success: false, message: '只能管理自己的学员或当日临时学员' })
    }
    const [[member]] = await pool.query(
      'SELECT id, status, last_training_date FROM members WHERE id = ?',
      [studentId]
    )
    if (!member || member.status === '已退队') {
      return res.status(404).json({ success: false, message: '学员不存在' })
    }
    const previousLastTrainingDate = toMySQLDate(member.last_training_date)
    await pool.query('UPDATE members SET last_training_date = ? WHERE id = ?', [date, studentId])
    try {
      const { syncProxyCheckinFromTrainingDate } = await import('../utils/checkinService.js')
      await syncProxyCheckinFromTrainingDate(studentId, date, {
        type: 'assistant',
        id: req.assistant.id,
        name: req.assistant.nickname || '助教',
        previousLastTrainingDate,
      })
    } catch (e) {
      console.warn('[assistant] sync checkin proxy', e.message)
    }
    res.json({ success: true, message: '已更新最后新训日期', data: { last_training_date: date } })
  } catch (error) {
    console.error('更新最后新训日期失败:', error)
    res.status(500).json({ success: false, message: '更新失败' })
  }
})

router.post('/assignments/request', requireAssistant, requirePerm('request_student'), async (req, res) => {
  try {
    const studentId = Number(req.body.student_member_id)
    if (!studentId) return res.status(400).json({ success: false, message: '请选择学员' })

    const [[student]] = await pool.query(
      'SELECT id, nickname, stage_role, status FROM members WHERE id = ?',
      [studentId]
    )
    if (!student || student.status === '已退队') {
      return res.status(404).json({ success: false, message: '学员不存在' })
    }
    if (!TRAINING_ROSTER_STAGES.includes(student.stage_role)) {
      return res.status(400).json({ success: false, message: '仅可申请新训阶段学员' })
    }

    const [existing] = await pool.query(
      `SELECT id, status FROM assistant_student_assignments
       WHERE assistant_member_id = ? AND student_member_id = ?`,
      [req.assistant.id, studentId]
    )
    if (existing.length > 0) {
      const st = existing[0].status
      if (st === '已通过' || st === '待审批') {
        return res.status(400).json({ success: false, message: st === '已通过' ? '已管理该学员' : '申请已在审批中' })
      }
      await pool.query(
        `UPDATE assistant_student_assignments
         SET status = '待审批', requested_by_type = 'assistant', requested_by_id = ?,
             reviewed_by_admin_id = NULL, reviewed_at = NULL, remarks = ?,
             hidden_from_approval = 0
         WHERE id = ?`,
        [req.assistant.id, req.body.remarks || null, existing[0].id]
      )
      return res.json({ success: true, message: '已重新提交申请', data: { id: existing[0].id } })
    }

    const [result] = await pool.query(
      `INSERT INTO assistant_student_assignments
        (assistant_member_id, student_member_id, status, requested_by_type, requested_by_id, remarks)
       VALUES (?, ?, '待审批', 'assistant', ?, ?)`,
      [req.assistant.id, studentId, req.assistant.id, req.body.remarks || null]
    )
    res.json({ success: true, message: '已提交带人申请', data: { id: result.insertId } })
  } catch (error) {
    console.error('助教申请带人失败:', error)
    res.status(500).json({ success: false, message: '提交失败' })
  }
})

router.put('/students/:id/stage', requireAssistant, async (req, res) => {
  try {
    const studentId = Number(req.params.id)
    const toStage = String(req.body.stage_role || '').trim()
    const reason = req.body.reason || null
    if (!toStage) return res.status(400).json({ success: false, message: '请选择阶段' })

    if (!(await isAssignedStudent(req.assistant.id, studentId))) {
      return res.status(403).json({ success: false, message: '只能管理已通过归属的学员' })
    }

    const [[student]] = await pool.query(
      'SELECT id, stage_role, status FROM members WHERE id = ?',
      [studentId]
    )
    if (!student || student.status === '已退队') {
      return res.status(404).json({ success: false, message: '学员不存在' })
    }

    if (!needsStageApproval(toStage)) {
      await pool.query('UPDATE members SET stage_role = ? WHERE id = ?', [toStage, studentId])
      await ensurePhase3ReachedAt(pool, studentId, toStage)
      return res.json({ success: true, message: '阶段已更新', data: { mode: 'direct' } })
    }

    if (!req.permissions.propose_stage_promotion) {
      return res.status(403).json({ success: false, message: '无升阶申请权限' })
    }

    const [pending] = await pool.query(
      `SELECT id FROM pending_stage_promotions
       WHERE assistant_member_id = ? AND student_member_id = ? AND status = '待审批'`,
      [req.assistant.id, studentId]
    )
    if (pending.length > 0) {
      await pool.query(
        `UPDATE pending_stage_promotions
         SET from_stage = ?, to_stage = ?, reason = COALESCE(?, reason)
         WHERE id = ?`,
        [student.stage_role, toStage, reason, pending[0].id]
      )
      return res.json({
        success: true,
        message: '已更新待审批的升阶申请',
        data: { id: pending[0].id, mode: 'pending' },
      })
    }

    const [result] = await pool.query(
      `INSERT INTO pending_stage_promotions
        (assistant_member_id, student_member_id, from_stage, to_stage, status, reason)
       VALUES (?, ?, ?, ?, '待审批', ?)`,
      [req.assistant.id, studentId, student.stage_role, toStage, reason]
    )
    res.json({ success: true, message: '升阶申请已提交，等待管理审批', data: { id: result.insertId, mode: 'pending' } })
  } catch (error) {
    console.error('助教改阶段失败:', error)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

router.get('/members/lookup-qq', requireAssistant, requirePerm('propose_member_create'), async (req, res) => {
  try {
    const qq = String(req.query.qq || '').trim()
    if (!qq) {
      return res.status(400).json({ success: false, message: '请提供 QQ 号' })
    }
    const [rows] = await pool.query(
      `SELECT id, nickname, qq, game_id, join_date, stage_role, status,
              last_training_date, phase3_reached_at, avatar
       FROM members WHERE qq = ? LIMIT 1`,
      [qq]
    )
    if (rows.length === 0) {
      return res.json({ success: true, data: { exists: false } })
    }
    res.json({ success: true, data: { exists: true, ...rows[0] } })
  } catch (error) {
    console.error('助教按 QQ 查询失败:', error)
    res.status(500).json({ success: false, message: '查询失败' })
  }
})

router.post('/members', requireAssistant, requirePerm('propose_member_create'), async (req, res) => {
  try {
    const { nickname, qq, game_id, join_date, stage_role } = req.body || {}
    if (!nickname || !qq) {
      return res.status(400).json({ success: false, message: '昵称和QQ号为必填项' })
    }
    const stage = stage_role || '未新训'

    const [[existing]] = await pool.query(
      `SELECT id, nickname, qq, game_id, join_date, stage_role, status
       FROM members WHERE qq = ? LIMIT 1`,
      [qq]
    )
    if (existing && existing.status !== '已退队') {
      return res.status(400).json({ success: false, message: 'QQ号已存在' })
    }

    const [pendingQq] = await pool.query(
      `SELECT id FROM pending_member_creates WHERE qq = ? AND status = '待审批' LIMIT 1`,
      [qq]
    )
    if (pendingQq.length > 0) {
      return res.status(400).json({ success: false, message: '该 QQ 已有待审批的添加申请' })
    }

    const isRestore = !!(existing && existing.status === '已退队')
    const finalNickname = String(nickname).trim() || existing?.nickname
    const finalGameId = game_id || existing?.game_id || null
    const finalJoin = toMySQLDate(join_date) || toMySQLDate(existing?.join_date) || toMySQLDate(new Date())
    const finalStage = DIRECT_STAGE_ALLOWED.has(stage)
      ? stage
      : (isRestore ? (DIRECT_STAGE_ALLOWED.has(existing.stage_role) ? existing.stage_role : '未新训') : '未新训')

    const [result] = await pool.query(
      `INSERT INTO pending_member_creates
        (assistant_member_id, nickname, qq, game_id, join_date, stage_role, status, restore_member_id)
       VALUES (?, ?, ?, ?, ?, ?, '待审批', ?)`,
      [
        req.assistant.id,
        finalNickname,
        qq,
        finalGameId,
        finalJoin,
        finalStage,
        isRestore ? existing.id : null,
      ]
    )

    res.json({
      success: true,
      message: isRestore
        ? '已提交恢复申请，等待管理审批（将调取原有档案数据）'
        : '添加申请已提交，等待管理审批',
      data: {
        id: result.insertId,
        mode: isRestore ? 'restore' : 'create',
        restore_member_id: isRestore ? existing.id : null,
      },
    })
  } catch (error) {
    console.error('助教添加成员失败:', error)
    res.status(500).json({ success: false, message: '提交失败' })
  }
})

router.get('/progress/members', requireAssistant, requirePerm('manage_assigned_progress'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id,
              m.nickname AS name,
              m.nickname,
              m.qq,
              m.avatar,
              m.stage_role AS status,
              m.join_date,
              m.last_training_date,
              COUNT(DISTINCT CASE WHEN scp.progress = 100 THEN scp.course_id END) AS completed_courses,
              (SELECT COUNT(*) FROM courses) AS total_courses
       FROM assistant_student_assignments a
       INNER JOIN members m ON m.id = a.student_member_id
       LEFT JOIN student_course_progress scp
         ON scp.member_id = m.id AND scp.progress = 100
       WHERE a.assistant_member_id = ? AND a.status = '已通过' AND m.status != '已退队'
       GROUP BY m.id
       ORDER BY m.nickname`,
      [req.assistant.id]
    )
    res.json({ success: true, data: rows })
  } catch (error) {
    console.error('助教进度成员失败:', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.get('/progress/member/:memberId', requireAssistant, requirePerm('manage_assigned_progress'), async (req, res) => {
  try {
    const memberId = Number(req.params.memberId)
    if (!(await isAssignedStudent(req.assistant.id, memberId))) {
      return res.status(403).json({ success: false, message: '只能查看已通过归属的学员' })
    }
    const [courses] = await pool.query(
      `SELECT c.id, c.code, c.name, c.category, c.difficulty, c.hours,
              COALESCE(scp.progress, 0) AS progress
       FROM courses c
       LEFT JOIN student_course_progress scp ON scp.course_id = c.id AND scp.member_id = ?
       ORDER BY c.\`order\``,
      [memberId]
    )
    res.json({ success: true, data: courses })
  } catch (error) {
    console.error('助教学员进度失败:', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.put(
  '/progress/member/:memberId/course/:courseId',
  requireAssistant,
  requirePerm('manage_assigned_progress'),
  async (req, res) => {
    try {
      const memberId = Number(req.params.memberId)
      const courseId = Number(req.params.courseId)
      const progress = Number(req.body.progress)
      const allowed = [0, 10, 20, 50, 75, 100]
      if (!allowed.includes(progress)) {
        return res.status(400).json({ success: false, message: '进度值无效' })
      }
      if (!(await isAssignedStudent(req.assistant.id, memberId))) {
        return res.status(403).json({ success: false, message: '只能管理已通过归属的学员' })
      }
      await pool.query(
        `INSERT INTO student_course_progress (member_id, course_id, progress)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE progress = VALUES(progress)`,
        [memberId, courseId, progress]
      )
      res.json({ success: true, message: '进度已更新' })
    } catch (error) {
      console.error('助教更新进度失败:', error)
      res.status(500).json({ success: false, message: '更新失败' })
    }
  }
)

/** 进度分配后同步阶段：一期及以下直接改；二期及以上仅返回候选，由前端询问是否申请审批 */
router.post('/progress/sync-stage', requireAssistant, requirePerm('manage_assigned_progress'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : []
    const memberIds = [...new Set(rawIds.map(Number).filter((id) => id > 0))]
    if (memberIds.length === 0) {
      return res.status(400).json({ success: false, message: '请选择学员' })
    }

    const assignedIds = new Set(await getAssignedStudentIds(req.assistant.id))
    for (const id of memberIds) {
      if (!assignedIds.has(id)) {
        return res.status(403).json({ success: false, message: '只能同步已通过归属的学员' })
      }
    }

    const [courses] = await pool.query('SELECT id, code FROM courses ORDER BY code')
    const placeholders = memberIds.map(() => '?').join(',')
    const [members] = await pool.query(
      `SELECT id, nickname, stage_role, status FROM members
       WHERE id IN (${placeholders}) AND status != '已退队'`,
      memberIds
    )

    const directUpdated = []
    const needsApproval = []
    const skipped = []
    const blocked = []

    for (const member of members) {
      if (STAGE_SYNC_SKIP_ROLES.includes(member.stage_role)) {
        skipped.push({ id: member.id, nickname: member.nickname, reason: '特殊阶段不自动同步' })
        continue
      }

      const [progress] = await pool.query(
        `SELECT course_id, progress FROM student_course_progress
         WHERE member_id = ? AND progress > 0`,
        [member.id]
      )
      const newStage = computeStageFromCourseProgress(courses, progress)
      if (!newStage) {
        skipped.push({ id: member.id, nickname: member.nickname, reason: '暂无课程进度' })
        continue
      }
      if (newStage === member.stage_role) {
        skipped.push({ id: member.id, nickname: member.nickname, reason: '阶段无变化' })
        continue
      }

      if (!needsStageApproval(newStage)) {
        await pool.query('UPDATE members SET stage_role = ? WHERE id = ?', [newStage, member.id])
        await ensurePhase3ReachedAt(pool, member.id, newStage)
        directUpdated.push({
          id: member.id,
          nickname: member.nickname,
          from: member.stage_role,
          to: newStage,
        })
        continue
      }

      if (!req.permissions.propose_stage_promotion) {
        blocked.push({
          id: member.id,
          nickname: member.nickname,
          from: member.stage_role,
          to: newStage,
          reason: '目标为二期及以上，需管理审批，但当前无升阶申请权限',
        })
        continue
      }

      const [pending] = await pool.query(
        `SELECT id, to_stage FROM pending_stage_promotions
         WHERE assistant_member_id = ? AND student_member_id = ? AND status = '待审批'`,
        [req.assistant.id, member.id]
      )
      needsApproval.push({
        id: member.id,
        nickname: member.nickname,
        from: member.stage_role,
        to: newStage,
        alreadyPending: pending.length > 0,
        pendingTo: pending[0]?.to_stage || null,
      })
    }

    const parts = []
    if (directUpdated.length > 0) parts.push(`已直接更新 ${directUpdated.length} 人阶段`)
    if (needsApproval.length > 0) {
      parts.push(`${needsApproval.length} 人目标为二期及以上，需确认是否申请管理审批`)
    }
    if (blocked.length > 0) parts.push(`${blocked.length} 人因无升阶权限无法申请审批`)
    if (parts.length === 0) parts.push('进度已保存，阶段无变化')

    res.json({
      success: true,
      message: parts.join('；'),
      data: { directUpdated, needsApproval, skipped, blocked },
    })
  } catch (error) {
    console.error('助教同步阶段失败:', error)
    res.status(500).json({ success: false, message: '同步阶段失败' })
  }
})

router.get('/reminders/training', requireAssistant, requirePerm('view_assigned_attendance'), async (req, res) => {
  try {
    const assignedIds = new Set(await getAssignedStudentIds(req.assistant.id))
    if (assignedIds.size === 0) {
      return res.json({ success: true, data: [], meta: { mode: 'remaining', total: 0 } })
    }

    const cfg = await loadReminderConfig()
    const mode = req.query.mode === 'kick_cycle' || req.query.mode === 'remaining'
      ? req.query.mode
      : cfg.displayMode

    let rows = []
    let warnDays = cfg.trainingWarnDays ?? TRAINING_WARN_DAYS
    let kickMeta = null

    if (mode === 'kick_cycle') {
      kickMeta = cfg.kickInfo
      if (cfg.kickInfo.inWindow) {
        warnDays = cfg.kickInfo.daysUntilKick
        rows = await queryTrainingReminders(cfg.defaultTimeoutDays, warnDays, {
          includeCustomExtended: false,
          includeLeaveBuffer: false,
          formalTimeoutDays: cfg.formalTimeoutDays,
        })
      }
    } else {
      warnDays = cfg.trainingWarnDays ?? TRAINING_WARN_DAYS
      rows = await queryTrainingReminders(cfg.defaultTimeoutDays, warnDays, {
        includeCustomExtended: true,
        formalTimeoutDays: cfg.formalTimeoutDays,
      })
    }

    const data = rows.filter((r) => assignedIds.has(Number(r.member_id || r.id)))
    res.json({
      success: true,
      data,
      meta: {
        mode,
        timeoutDays: cfg.defaultTimeoutDays,
        warnDays,
        today: cfg.todayIso,
        kick: kickMeta,
        total: data.length,
      },
    })
  } catch (error) {
    console.error('助教训练催促失败:', error)
    res.status(500).json({ success: false, message: '获取训练催促失败' })
  }
})

router.get('/attendance', requireAssistant, requirePerm('view_assigned_attendance'), async (req, res) => {
  try {
    const showAll = req.query.showAll === '1' || req.query.showAll === 'true'
    const [members] = await pool.query(
      `SELECT m.id, m.nickname, m.qq, m.stage_role, m.status, m.join_date,
              m.last_training_date, m.phase3_reached_at, m.avatar,
              CASE WHEN ret.id IS NOT NULL THEN 1 ELSE 0 END AS in_retention
       FROM assistant_student_assignments a
       INNER JOIN members m ON m.id = a.student_member_id
       LEFT JOIN retention_records ret ON m.id = ret.member_id
       WHERE a.assistant_member_id = ? AND a.status = '已通过'
         AND m.status NOT IN ('已退队', '其他')`,
      [req.assistant.id]
    )
    const ids = members.map((m) => m.id)
    let leaveMap = new Map()
    if (ids.length > 0) {
      const [leaves] = await pool.query(
        `SELECT member_id, start_date, end_date, status FROM leave_records
         WHERE member_id IN (${ids.map(() => '?').join(',')})
           AND status IN ('请假中', '待结束审批', '已结束')`,
        ids
      )
      for (const row of leaves) {
        if (!leaveMap.has(row.member_id)) leaveMap.set(row.member_id, [])
        leaveMap.get(row.member_id).push(row)
      }
    }
    const [ignores] = await pool.query('SELECT member_id FROM attendance_reminder_ignores')
    const ignoreSet = new Set(ignores.map((r) => r.member_id))

    let overrideMap = new Map()
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS attendance_reminder_overrides (
          id INT PRIMARY KEY AUTO_INCREMENT,
          member_id INT NOT NULL,
          reason_code VARCHAR(32) NOT NULL,
          custom_deadline_days INT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_member_reason (member_id, reason_code),
          INDEX idx_aro_member (member_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      if (ids.length > 0) {
        const [overrides] = await pool.query(
          `SELECT member_id, reason_code, custom_deadline_days FROM attendance_reminder_overrides
           WHERE member_id IN (${ids.map(() => '?').join(',')})`,
          ids
        )
        for (const row of overrides) {
          if (!overrideMap.has(row.member_id)) overrideMap.set(row.member_id, {})
          overrideMap.get(row.member_id)[row.reason_code] = Number(row.custom_deadline_days)
        }
      }
    } catch (e) {
      console.error('[assistant] load attendance overrides', e.message)
    }

    const { formalTimeoutDays, use180Set, rulesConfig } = await loadFormalAttendancePolicy()
    const attendanceWarnDays = rulesConfig?.attendance?.warnDays ?? ATTENDANCE_WARN_DAYS
    const items = []
    for (const m of members) {
      const item = computeAttendanceForMember(m, leaveMap.get(m.id) || [], {
        ignored: ignoreSet.has(m.id),
        inRetention: !!m.in_retention,
        showAll,
        overrides: overrideMap.get(m.id) || {},
        formalTimeoutDays,
        useFormal180: use180Set.has(Number(m.id)),
        rulesConfig,
      })
      if (item) items.push({ ...item, avatar: m.avatar })
    }
    items.sort((a, b) => a.remaining_days - b.remaining_days)

    const warnItems = showAll
      ? items.filter((i) => !i.ignored && i.remaining_days <= attendanceWarnDays)
      : items

    res.json({
      success: true,
      data: items,
      meta: {
        showAll,
        warnDays: attendanceWarnDays,
        total: items.length,
        warnCount: warnItems.length,
      },
    })
  } catch (error) {
    console.error('助教考勤失败:', error)
    res.status(500).json({ success: false, message: '获取考勤失败' })
  }
})

router.post('/quit', requireAssistant, requirePerm('propose_quit'), async (req, res) => {
  try {
    const memberId = Number(req.body.member_id)
    const remarks = String(req.body.remarks || '').trim()
    if (!memberId) return res.status(400).json({ success: false, message: '请选择学员' })
    if (!remarks) return res.status(400).json({ success: false, message: '请填写退队原因' })
    if (!(await isAssignedStudent(req.assistant.id, memberId))) {
      return res.status(403).json({ success: false, message: '只能对自己的学员发起退队' })
    }

    const [existing] = await pool.query(
      `SELECT id FROM quit_approvals WHERE member_id = ? AND status = '待审批'`,
      [memberId]
    )
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: '该成员已有待审批的退队记录' })
    }

    const [[member]] = await pool.query('SELECT nickname, qq FROM members WHERE id = ?', [memberId])
    if (!member) return res.status(404).json({ success: false, message: '成员不存在' })

    const [result] = await pool.query(
      `INSERT INTO quit_approvals (
         member_id, member_name, qq, apply_date, source_type,
         source_admin_id, source_admin_name, source_assistant_id, source_assistant_name,
         status, remarks
       ) VALUES (?, ?, ?, ?, '助教', NULL, NULL, ?, ?, '待审批', ?)`,
      [
        memberId,
        member.nickname,
        member.qq,
        new Date().toISOString().split('T')[0],
        req.assistant.id,
        req.assistant.nickname,
        remarks,
      ]
    )

    await pool.query(`UPDATE members SET status = '已退队' WHERE id = ?`, [memberId])

    res.json({ success: true, message: '退队申请已提交，等待管理审批', data: { id: result.insertId } })
  } catch (error) {
    console.error('助教退队失败:', error)
    res.status(500).json({ success: false, message: '提交失败' })
  }
})

router.get('/my-requests', requireAssistant, async (req, res) => {
  try {
    const aid = req.assistant.id
    const [assignments] = await pool.query(
      `SELECT a.*, m.nickname AS student_name, m.qq AS student_qq
       FROM assistant_student_assignments a
       LEFT JOIN members m ON m.id = a.student_member_id
       WHERE a.assistant_member_id = ? AND a.requested_by_type = 'assistant'
         AND COALESCE(a.hidden_from_approval, 0) = 0
       ORDER BY a.created_at DESC LIMIT 50`,
      [aid]
    )
    const [creates] = await pool.query(
      `SELECT * FROM pending_member_creates WHERE assistant_member_id = ? ORDER BY created_at DESC LIMIT 50`,
      [aid]
    )
    const [promotions] = await pool.query(
      `SELECT p.*, m.nickname AS student_name
       FROM pending_stage_promotions p
       LEFT JOIN members m ON m.id = p.student_member_id
       WHERE p.assistant_member_id = ?
       ORDER BY p.created_at DESC LIMIT 50`,
      [aid]
    )
    const [edits] = await pool.query(
      `SELECT e.*, m.nickname AS student_name, m.qq AS student_qq,
              m.game_id AS student_game_id, m.join_date AS student_join_date,
              m.phase3_reached_at AS student_phase3_reached_at, m.remarks AS student_remarks,
              m.status AS student_status, m.last_training_date AS student_last_training_date
       FROM pending_member_edits e
       LEFT JOIN members m ON m.id = e.student_member_id
       WHERE e.assistant_member_id = ?
       ORDER BY e.created_at DESC LIMIT 50`,
      [aid]
    )
    const editsWithMember = (edits || []).map((e) => ({
      ...e,
      student_current: {
        nickname: e.student_name,
        qq: e.student_qq,
        game_id: e.student_game_id,
        join_date: e.student_join_date,
        phase3_reached_at: e.student_phase3_reached_at,
        remarks: e.student_remarks,
        status: e.student_status,
        last_training_date: e.student_last_training_date,
      },
    }))
    const [blackPoints] = await pool.query(
      `SELECT b.*, m.nickname AS student_name
       FROM pending_black_points b
       LEFT JOIN members m ON m.id = b.student_member_id
       WHERE b.assistant_member_id = ?
       ORDER BY b.created_at DESC LIMIT 50`,
      [aid]
    )
    const [leaves] = await pool.query(
      `SELECT l.*, m.nickname AS student_name
       FROM pending_leaves l
       LEFT JOIN members m ON m.id = l.student_member_id
       WHERE l.assistant_member_id = ?
       ORDER BY l.created_at DESC LIMIT 50`,
      [aid]
    )
    res.json({
      success: true,
      data: {
        assignments,
        creates,
        promotions,
        edits: editsWithMember,
        blackPoints,
        leaves,
      },
    })
  } catch (error) {
    console.error('助教申请列表失败:', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

/** 助教删除自己的已完结申请 —— 已取消，仅管理端可删或撤销助教时清理 */
router.delete('/my-requests/:type/:id', requireAssistant, async (_req, res) => {
  res.status(403).json({ success: false, message: '助教不可删除申请记录，请由管理在审批中心处理' })
})

/** 学员详情（仅已归属） */
router.get('/students/:id/detail', requireAssistant, async (req, res) => {
  try {
    const studentId = Number(req.params.id)
    if (!(await isAssignedStudent(req.assistant.id, studentId))) {
      return res.status(403).json({ success: false, message: '只能查看已通过归属的学员' })
    }
    const [[member]] = await pool.query(
      `SELECT id, nickname, qq, game_id, join_date, stage_role, status, last_training_date,
              phase3_reached_at, remarks, avatar, created_at, is_ziye_assistant
       FROM members WHERE id = ?`,
      [studentId]
    )
    if (!member) return res.status(404).json({ success: false, message: '学员不存在' })

    const [blackPoints] = await pool.query(
      `SELECT id, reason, register_date, status FROM black_point_records
       WHERE member_id = ? ORDER BY register_date DESC`,
      [studentId]
    )
    const [leaveRecords] = await pool.query(
      `SELECT id, start_date, end_date, status, reason, total_days FROM leave_records
       WHERE member_id = ? ORDER BY created_at DESC`,
      [studentId]
    )
    res.json({ success: true, data: { member, blackPoints, leaveRecords } })
  } catch (error) {
    console.error('助教学员详情失败:', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.post('/students/:id/propose-edit', requireAssistant, requirePerm('propose_member_edit'), async (req, res) => {
  try {
    const studentId = Number(req.params.id)
    if (!(await isAssignedStudent(req.assistant.id, studentId))) {
      return res.status(403).json({ success: false, message: '只能修改已通过归属的学员' })
    }
    if (req.body?.stage_role) {
      return res.status(400).json({ success: false, message: '阶段请使用「改阶段」功能' })
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'last_training_date')) {
      return res.status(400).json({ success: false, message: '最后新训日期请使用「今日新训」直接更新' })
    }

    const [[member]] = await pool.query(
      `SELECT nickname, qq, game_id, join_date, phase3_reached_at, remarks, status
       FROM members WHERE id = ?`,
      [studentId]
    )
    if (!member) return res.status(404).json({ success: false, message: '学员不存在' })

    const allowed = ['nickname', 'qq', 'game_id', 'join_date', 'phase3_reached_at', 'remarks', 'status']
    const norm = (key, val) => {
      if (val == null || val === '') return null
      if (key === 'join_date' || key === 'phase3_reached_at') return toMySQLDate(val)
      if (typeof val === 'string') {
        const t = val.trim()
        return t === '' ? null : t
      }
      return val
    }
    const same = (a, b) => {
      const sa = a == null ? null : String(a)
      const sb = b == null ? null : String(b)
      return sa === sb
    }

    const changes = {}
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, key)) continue
      const from = norm(key, member[key])
      const to = norm(key, req.body[key])
      if (same(from, to)) continue
      changes[key] = { from, to }
    }
    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ success: false, message: '没有实际变更的字段' })
    }

    const [pending] = await pool.query(
      `SELECT id FROM pending_member_edits
       WHERE assistant_member_id = ? AND student_member_id = ? AND status = '待审批'`,
      [req.assistant.id, studentId]
    )
    if (pending.length > 0) {
      await pool.query(
        `UPDATE pending_member_edits SET changes_json = ? WHERE id = ?`,
        [JSON.stringify(changes), pending[0].id]
      )
      return res.json({
        success: true,
        message: '已更新待审批的信息修改申请',
        data: { id: pending[0].id, changes },
      })
    }
    const [result] = await pool.query(
      `INSERT INTO pending_member_edits
        (assistant_member_id, student_member_id, changes_json, status)
       VALUES (?, ?, ?, '待审批')`,
      [req.assistant.id, studentId, JSON.stringify(changes)]
    )
    res.json({
      success: true,
      message: '信息修改已提交，等待管理审批',
      data: { id: result.insertId, changes },
    })
  } catch (error) {
    console.error('助教提学员修改失败:', error)
    res.status(500).json({ success: false, message: '提交失败' })
  }
})

router.post('/students/:id/propose-black-point', requireAssistant, requirePerm('propose_black_point'), async (req, res) => {
  try {
    const studentId = Number(req.params.id)
    const reason = String(req.body?.reason || '').trim()
    const register_date = req.body?.register_date || new Date().toISOString().split('T')[0]
    if (!reason) return res.status(400).json({ success: false, message: '请填写黑点原因' })
    if (!(await isAssignedStudent(req.assistant.id, studentId))) {
      return res.status(403).json({ success: false, message: '只能为自己的学员登记黑点' })
    }
    const [result] = await pool.query(
      `INSERT INTO pending_black_points
        (assistant_member_id, student_member_id, reason, register_date, status)
       VALUES (?, ?, ?, ?, '待审批')`,
      [req.assistant.id, studentId, reason, register_date]
    )
    res.json({ success: true, message: '黑点申请已提交，等待管理审批', data: { id: result.insertId } })
  } catch (error) {
    console.error('助教提黑点失败:', error)
    res.status(500).json({ success: false, message: '提交失败' })
  }
})

router.post('/students/:id/propose-leave', requireAssistant, requirePerm('propose_leave'), async (req, res) => {
  try {
    const studentId = Number(req.params.id)
    const reason = req.body?.reason || ''
    const start_date = req.body?.start_date
    const end_date = req.body?.end_date
    if (!start_date || !end_date) {
      return res.status(400).json({ success: false, message: '请填写请假起止日期' })
    }
    if (!(await isAssignedStudent(req.assistant.id, studentId))) {
      return res.status(403).json({ success: false, message: '只能为自己的学员登记请假' })
    }
    const [result] = await pool.query(
      `INSERT INTO pending_leaves
        (assistant_member_id, student_member_id, reason, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, '待审批')`,
      [req.assistant.id, studentId, reason, start_date, end_date]
    )
    res.json({ success: true, message: '请假申请已提交，等待管理审批', data: { id: result.insertId } })
  } catch (error) {
    console.error('助教提请假失败:', error)
    res.status(500).json({ success: false, message: '提交失败' })
  }
})

/** 助教名下学员的进行中请假（含待结束审批） */
router.get('/leaves/active', requireAssistant, requirePerm('propose_leave'), async (req, res) => {
  try {
    const ids = await getAssignedStudentIds(req.assistant.id)
    if (ids.length === 0) return res.json({ success: true, data: [] })
    const placeholders = ids.map(() => '?').join(',')
    const [rows] = await pool.query(
      `SELECT lr.id, lr.member_id, lr.member_name, lr.qq, lr.reason, lr.start_date, lr.end_date,
              lr.total_days, lr.status, lr.created_at, m.avatar, m.nickname AS student_name
       FROM leave_records lr
       LEFT JOIN members m ON m.id = lr.member_id
       WHERE lr.member_id IN (${placeholders})
         AND lr.status IN ('请假中', '待结束审批')
       ORDER BY lr.start_date DESC`,
      ids
    )
    res.json({ success: true, data: rows })
  } catch (error) {
    console.error('助教进行中请假列表失败:', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

/** 助教提前结束所属学员的请假（直接生效，进入 7 天缓冲） */
router.put('/leaves/:id/end-early', requireAssistant, requirePerm('propose_leave'), async (req, res) => {
  try {
    const id = Number(req.params.id)
    const [[leave]] = await pool.query('SELECT * FROM leave_records WHERE id = ?', [id])
    if (!leave) return res.status(404).json({ success: false, message: '请假记录不存在' })
    if (leave.status !== '请假中' && leave.status !== '待结束审批') {
      return res.status(400).json({ success: false, message: '仅可结束进行中的请假' })
    }
    if (!(await isAssignedStudent(req.assistant.id, leave.member_id))) {
      return res.status(403).json({ success: false, message: '只能操作自己学员的请假' })
    }

    const today = shanghaiToday()
    const start = toMySQLDate(leave.start_date) || today
    const [[dateDiff]] = await pool.query('SELECT DATEDIFF(?, ?) AS total_days', [today, start])
    const totalDays = Math.max(1, (dateDiff?.total_days ?? 0) + 1)

    await pool.query(
      `UPDATE leave_records SET
         status = '已结束',
         end_date = ?,
         total_days = ?,
         buffer_start_date = CURDATE(),
         end_approver_name = ?
       WHERE id = ?`,
      [today, totalDays, `${req.assistant.nickname || '助教'}（助教）`, id]
    )
    await pool.query(`UPDATE members SET status = '正常' WHERE id = ? AND status = '请假中'`, [
      leave.member_id,
    ])

    res.json({ success: true, message: '已提前结束请假，学员进入 7 天缓冲期' })
  } catch (error) {
    console.error('助教提前结束请假失败:', error)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

// ─── 管理端 ─────────────────────────────────────────────

router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    // 修复历史：已撤销助教但仍残留的归属/申请
    await cleanupOrphanedAssistantData(pool, ASSISTANT_ROLE).catch((e) => {
      console.warn('清理残留助教数据失败:', e.message)
    })
    const [rows] = await pool.query(
      `SELECT m.id, m.nickname, m.qq, m.stage_role, m.avatar, m.status,
              m.is_assistant, m.is_ziye_assistant, m.screen_share_enabled, m.screen_share_quota, m.screen_share_used,
              m.guest_code_max,
              ap.permissions_json,
              (SELECT COUNT(*) FROM assistant_student_assignments a
               WHERE a.assistant_member_id = m.id AND a.status = '已通过') AS student_count
       FROM members m
       LEFT JOIN assistant_permissions ap ON ap.assistant_member_id = m.id
       WHERE m.status != '已退队'
         AND (m.is_ziye_assistant = 1 OR m.stage_role = ?)
       ORDER BY m.nickname`,
      [ASSISTANT_ROLE]
    )
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        permissions: mergePermissions(r.permissions_json),
      })),
    })
  } catch (error) {
    console.error('管理助教列表失败:', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.put('/admin/:id/permissions', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const permissions = mergePermissions(req.body.permissions || {})
    const screenShare = req.body.screen_share || {}
    const [[member]] = await pool.query(
      'SELECT id, stage_role, is_ziye_assistant FROM members WHERE id = ?',
      [id]
    )
    if (!member || !isZiyeAssistantMember(member)) {
      return res.status(404).json({ success: false, message: '不是紫夜助教' })
    }
    await pool.query(
      `INSERT INTO assistant_permissions (assistant_member_id, permissions_json, updated_by_admin_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE permissions_json = VALUES(permissions_json), updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [id, JSON.stringify(permissions), req.admin.id]
    )
    await syncScreenShareSettings(id, !!permissions.screen_share_assistant, screenShare)
    const [[updated]] = await pool.query(
      `SELECT is_assistant, screen_share_enabled, screen_share_quota, screen_share_used, guest_code_max
       FROM members WHERE id = ?`,
      [id]
    )
    res.json({
      success: true,
      message: '权限已更新',
      data: { permissions, screen_share: updated },
    })
  } catch (error) {
    console.error('更新助教权限失败:', error)
    res.status(500).json({ success: false, message: '更新失败' })
  }
})

/** 授予助教身份（不改 stage_role，可与尖兵并存） */
router.post('/admin/:id/enable', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const [[member]] = await pool.query(
      'SELECT id, status FROM members WHERE id = ?',
      [id]
    )
    if (!member || member.status === '已退队') {
      return res.status(404).json({ success: false, message: '成员不存在' })
    }
    await pool.query('UPDATE members SET is_ziye_assistant = 1 WHERE id = ?', [id])
    await pool.query(
      `INSERT INTO assistant_permissions (assistant_member_id, permissions_json, updated_by_admin_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [id, JSON.stringify(DEFAULT_ASSISTANT_PERMISSIONS), req.admin.id]
    )
    res.json({ success: true, message: '已设为紫夜助教（保留原阶段）' })
  } catch (error) {
    console.error('授予助教失败:', error)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** 撤销助教身份（不改 stage_role；阶段本身为「紫夜助教」时不可撤销） */
router.post('/admin/:id/disable', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const [[m]] = await pool.query(
      'SELECT id, stage_role, is_ziye_assistant FROM members WHERE id = ?',
      [id]
    )
    if (!m) return res.status(404).json({ success: false, message: '成员不存在' })
    if (m.stage_role === ASSISTANT_ROLE) {
      return res.status(400).json({
        success: false,
        message: '当前阶段为「紫夜助教」，请先将阶段调整为其他身份后再撤销助教',
      })
    }
    if (!isZiyeAssistantMember(m)) {
      return res.status(400).json({ success: false, message: '该成员不是紫夜助教' })
    }
    await clearAssistantRoleData(pool, id)
    await pool.query('UPDATE members SET is_ziye_assistant = 0, is_assistant = 0 WHERE id = ?', [id])
    res.json({
      success: true,
      message: '已撤销紫夜助教身份，并清除其学员归属与助教申请记录',
    })
  } catch (error) {
    console.error('撤销助教失败:', error)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

router.post('/admin/assignments', requireAdmin, async (req, res) => {
  try {
    const assistantId = Number(req.body.assistant_member_id)
    const studentId = Number(req.body.student_member_id)
    if (!assistantId || !studentId) {
      return res.status(400).json({ success: false, message: '参数不完整' })
    }
    const [[asst]] = await pool.query(
      'SELECT id, stage_role, is_ziye_assistant FROM members WHERE id = ?',
      [assistantId]
    )
    if (!asst || !isZiyeAssistantMember(asst)) {
      return res.status(400).json({ success: false, message: '助教不存在' })
    }

    const [existing] = await pool.query(
      `SELECT id, status FROM assistant_student_assignments
       WHERE assistant_member_id = ? AND student_member_id = ?`,
      [assistantId, studentId]
    )
    if (existing.length > 0) {
      await pool.query(
        `UPDATE assistant_student_assignments
         SET status = '已通过', requested_by_type = 'admin', requested_by_id = ?,
             reviewed_by_admin_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.admin.id, req.admin.id, existing[0].id]
      )
      return res.json({ success: true, message: '已分配', data: { id: existing[0].id } })
    }
    const [result] = await pool.query(
      `INSERT INTO assistant_student_assignments
        (assistant_member_id, student_member_id, status, requested_by_type, requested_by_id, reviewed_by_admin_id, reviewed_at)
       VALUES (?, ?, '已通过', 'admin', ?, ?, NOW())`,
      [assistantId, studentId, req.admin.id, req.admin.id]
    )
    res.json({ success: true, message: '已分配', data: { id: result.insertId } })
  } catch (error) {
    console.error('管理分配学员失败:', error)
    res.status(500).json({ success: false, message: '分配失败' })
  }
})

router.delete('/admin/assignments/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `UPDATE assistant_student_assignments
       SET status = '已解除', reviewed_by_admin_id = ?, reviewed_at = NOW(), hidden_from_approval = 0
       WHERE id = ?`,
      [req.admin.id, req.params.id]
    )
    res.json({ success: true, message: '已解除归属' })
  } catch (error) {
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** 审批中心列表：待审批优先，含已处理记录（上限每类 200） */
function adminPendingOrder(alias) {
  return `ORDER BY (${alias}.status = '待审批') DESC, COALESCE(${alias}.reviewed_at, ${alias}.created_at) DESC, ${alias}.created_at DESC LIMIT 200`
}

router.get('/admin/pending', requireAdmin, async (req, res) => {
  try {
    const [assignments] = await pool.query(
      `SELECT a.*,
              am.nickname AS assistant_name, am.qq AS assistant_qq,
              sm.nickname AS student_name, sm.qq AS student_qq, sm.stage_role AS student_stage
       FROM assistant_student_assignments a
       LEFT JOIN members am ON am.id = a.assistant_member_id
       LEFT JOIN members sm ON sm.id = a.student_member_id
       WHERE a.requested_by_type = 'assistant'
         AND COALESCE(a.hidden_from_approval, 0) = 0
       ${adminPendingOrder('a')}`
    )
    const [creates] = await pool.query(
      `SELECT p.*, m.nickname AS assistant_name
       FROM pending_member_creates p
       LEFT JOIN members m ON m.id = p.assistant_member_id
       ${adminPendingOrder('p')}`
    )
    const [promotions] = await pool.query(
      `SELECT p.*, am.nickname AS assistant_name, sm.nickname AS student_name, sm.qq AS student_qq
       FROM pending_stage_promotions p
       LEFT JOIN members am ON am.id = p.assistant_member_id
       LEFT JOIN members sm ON sm.id = p.student_member_id
       ${adminPendingOrder('p')}`
    )
    const [edits] = await pool.query(
      `SELECT e.*, am.nickname AS assistant_name, sm.nickname AS student_name, sm.qq AS student_qq
       FROM pending_member_edits e
       LEFT JOIN members am ON am.id = e.assistant_member_id
       LEFT JOIN members sm ON sm.id = e.student_member_id
       ${adminPendingOrder('e')}`
    )
    const [blackPoints] = await pool.query(
      `SELECT b.*, am.nickname AS assistant_name, sm.nickname AS student_name, sm.qq AS student_qq
       FROM pending_black_points b
       LEFT JOIN members am ON am.id = b.assistant_member_id
       LEFT JOIN members sm ON sm.id = b.student_member_id
       ${adminPendingOrder('b')}`
    )
    const [leaves] = await pool.query(
      `SELECT l.*, am.nickname AS assistant_name, sm.nickname AS student_name, sm.qq AS student_qq
       FROM pending_leaves l
       LEFT JOIN members am ON am.id = l.assistant_member_id
       LEFT JOIN members sm ON sm.id = l.student_member_id
       ${adminPendingOrder('l')}`
    )
    res.json({
      success: true,
      data: { assignments, creates, promotions, edits, blackPoints, leaves },
    })
  } catch (error) {
    console.error('管理待审失败:', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

/** 管理端删除已完结审批（不可删待审批） */
const ADMIN_REQUEST_DELETE_MAP = {
  assignments: {
    table: 'assistant_student_assignments',
    done: ['已通过', '已拒绝', '已解除'],
  },
  creates: {
    table: 'pending_member_creates',
    done: ['已通过', '已驳回'],
  },
  promotions: {
    table: 'pending_stage_promotions',
    done: ['已通过', '已驳回'],
  },
  edits: {
    table: 'pending_member_edits',
    done: ['已通过', '已驳回'],
  },
  blackPoints: {
    table: 'pending_black_points',
    done: ['已通过', '已驳回'],
  },
  leaves: {
    table: 'pending_leaves',
    done: ['已通过', '已驳回'],
  },
}

router.delete('/admin/requests/:type/:id', requireAdmin, async (req, res) => {
  try {
    const type = String(req.params.type || '')
    const id = Number(req.params.id)
    const conf = ADMIN_REQUEST_DELETE_MAP[type]
    if (!conf || !Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '参数无效' })
    }
    const [[row]] = await pool.query(`SELECT id, status FROM ${conf.table} WHERE id = ?`, [id])
    if (!row) return res.status(404).json({ success: false, message: '记录不存在' })
    if (!conf.done.includes(row.status)) {
      return res.status(400).json({ success: false, message: '仅可删除已处理的记录' })
    }

    // 已通过认领：仅从审批中心隐藏，不解除归属
    if (type === 'assignments' && row.status === '已通过') {
      await pool.query(
        `UPDATE assistant_student_assignments SET hidden_from_approval = 1 WHERE id = ?`,
        [id]
      )
      return res.json({ success: true, message: '已从审批中心移除（归属保留）' })
    }

    await pool.query(`DELETE FROM ${conf.table} WHERE id = ?`, [id])
    res.json({ success: true, message: '已删除' })
  } catch (error) {
    console.error('管理端删除审批失败:', error)
    res.status(500).json({ success: false, message: '删除失败' })
  }
})

router.put('/admin/assignments/:id/review', requireAdmin, async (req, res) => {
  try {
    const status = req.body.status === '已通过' ? '已通过' : '已拒绝'
    await pool.query(
      `UPDATE assistant_student_assignments
       SET status = ?, reviewed_by_admin_id = ?, reviewed_at = NOW(),
           remarks = COALESCE(?, remarks), hidden_from_approval = 0
       WHERE id = ? AND status = '待审批'`,
      [status, req.admin.id, req.body.remarks || null, req.params.id]
    )
    res.json({ success: true, message: status === '已通过' ? '已通过' : '已拒绝' })
  } catch (error) {
    res.status(500).json({ success: false, message: '审批失败' })
  }
})

router.put('/admin/member-creates/:id/review', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const approve = req.body.status === '已通过'
    const [[row]] = await pool.query(
      `SELECT * FROM pending_member_creates WHERE id = ? AND status = '待审批'`,
      [id]
    )
    if (!row) return res.status(404).json({ success: false, message: '申请不存在' })

    if (!approve) {
      await pool.query(
        `UPDATE pending_member_creates
         SET status = '已驳回', reject_reason = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.body.reject_reason || null, req.admin.id, id]
      )
      return res.json({ success: true, message: '已驳回' })
    }

    let memberId = null

    if (row.restore_member_id) {
      const [[archived]] = await pool.query(
        'SELECT id, nickname, username, status, stage_role FROM members WHERE id = ?',
        [row.restore_member_id]
      )
      if (!archived) {
        return res.status(404).json({ success: false, message: '待恢复档案不存在' })
      }
      if (archived.status !== '已退队') {
        return res.status(400).json({ success: false, message: '该成员已不在退队状态，无法恢复' })
      }

      const newNickname = row.nickname || archived.nickname
      const newUsername = newNickname
      const newStageRole = row.stage_role || archived.stage_role || '未新训'

      if (newNickname !== archived.nickname || newUsername !== archived.username) {
        const [conflict] = await pool.query(
          'SELECT id FROM members WHERE (username = ? OR nickname = ?) AND id != ? LIMIT 1',
          [newUsername, newNickname, archived.id]
        )
        if (conflict.length > 0) {
          return res.status(400).json({ success: false, message: '昵称已被其他成员占用' })
        }
      }

      await pool.query(
        `UPDATE members
         SET status = '正常',
             join_date = ?,
             phase3_reached_at = NULL,
             nickname = ?,
             username = ?,
             stage_role = ?,
             game_id = COALESCE(?, game_id)
         WHERE id = ?`,
        [
          toMySQLDate(row.join_date) || toMySQLDate(new Date()),
          newNickname,
          newUsername,
          newStageRole,
          row.game_id || null,
          archived.id,
        ]
      )
      memberId = archived.id
      await ensurePhase3ReachedAt(pool, memberId, newStageRole)
    } else {
      const [byQq] = await pool.query('SELECT id, status FROM members WHERE qq = ? LIMIT 1', [row.qq])
      if (byQq.length > 0 && byQq[0].status !== '已退队') {
        return res.status(400).json({ success: false, message: 'QQ号已存在，无法通过' })
      }
      if (byQq.length > 0 && byQq[0].status === '已退队') {
        return res.status(400).json({
          success: false,
          message: '该 QQ 对应已退队档案，请驳回后让助教重新提交以走恢复流程',
        })
      }

      const hashed = await bcrypt.hash(row.qq, 10)
      const [insert] = await pool.query(
        `INSERT INTO members (username, password, nickname, qq, game_id, join_date, stage_role, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, '正常')`,
        [
          row.nickname,
          hashed,
          row.nickname,
          row.qq,
          row.game_id || null,
          toMySQLDate(row.join_date) || toMySQLDate(new Date()),
          row.stage_role || '未新训',
        ]
      )
      memberId = insert.insertId
      await ensurePhase3ReachedAt(pool, memberId, row.stage_role || '未新训')
    }

    await pool.query(
      `INSERT INTO assistant_student_assignments
        (assistant_member_id, student_member_id, status, requested_by_type, requested_by_id, reviewed_by_admin_id, reviewed_at)
       VALUES (?, ?, '已通过', 'assistant', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE status = '已通过', reviewed_by_admin_id = VALUES(reviewed_by_admin_id), reviewed_at = NOW()`,
      [row.assistant_member_id, memberId, row.assistant_member_id, req.admin.id]
    )

    await pool.query(
      `UPDATE pending_member_creates
       SET status = '已通过', created_member_id = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [memberId, req.admin.id, id]
    )

    res.json({
      success: true,
      message: row.restore_member_id ? '已恢复成员并归属助教' : '已通过并创建成员',
      data: { member_id: memberId, mode: row.restore_member_id ? 'restore' : 'create' },
    })
  } catch (error) {
    console.error('审批加人失败:', error)
    res.status(500).json({ success: false, message: '审批失败' })
  }
})

router.put('/admin/stage-promotions/:id/review', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const approve = req.body.status === '已通过'
    const [[row]] = await pool.query(
      `SELECT * FROM pending_stage_promotions WHERE id = ? AND status = '待审批'`,
      [id]
    )
    if (!row) return res.status(404).json({ success: false, message: '申请不存在' })

    if (!approve) {
      await pool.query(
        `UPDATE pending_stage_promotions
         SET status = '已驳回', reject_reason = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.body.reject_reason || null, req.admin.id, id]
      )
      return res.json({ success: true, message: '已驳回' })
    }

    await pool.query('UPDATE members SET stage_role = ? WHERE id = ?', [row.to_stage, row.student_member_id])
    await ensurePhase3ReachedAt(pool, row.student_member_id, row.to_stage)
    await pool.query(
      `UPDATE pending_stage_promotions
       SET status = '已通过', reviewed_by_admin_id = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [req.admin.id, id]
    )
    res.json({ success: true, message: '已通过升阶' })
  } catch (error) {
    console.error('审批升阶失败:', error)
    res.status(500).json({ success: false, message: '审批失败' })
  }
})

router.put('/admin/member-edits/:id/review', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const approve = req.body.status === '已通过'
    const [[row]] = await pool.query(
      `SELECT * FROM pending_member_edits WHERE id = ? AND status = '待审批'`,
      [id]
    )
    if (!row) return res.status(404).json({ success: false, message: '申请不存在' })

    if (!approve) {
      await pool.query(
        `UPDATE pending_member_edits
         SET status = '已驳回', reject_reason = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.body.reject_reason || null, req.admin.id, id]
      )
      return res.json({ success: true, message: '已驳回' })
    }

    let changes = row.changes_json
    if (typeof changes === 'string') {
      try {
        changes = JSON.parse(changes)
      } catch {
        return res.status(400).json({ success: false, message: '修改内容无效' })
      }
    }
    if (!changes || typeof changes !== 'object') {
      return res.status(400).json({ success: false, message: '修改内容无效' })
    }

    const resolveTo = (raw) => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && ('to' in raw || 'from' in raw)) {
        return raw.to
      }
      return raw
    }

    const allowed = ['nickname', 'qq', 'game_id', 'join_date', 'last_training_date', 'phase3_reached_at', 'remarks', 'status']
    const sets = []
    const vals = []
    let nicknameTo = null
    let qqTo = null
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue
      let val = resolveTo(changes[key])
      if (key === 'join_date' || key === 'last_training_date' || key === 'phase3_reached_at') {
        val = val ? toMySQLDate(val) : null
      }
      if (key === 'nickname') nicknameTo = val
      if (key === 'qq') qqTo = val
      if (key === 'nickname' && val) {
        sets.push('nickname = ?', 'username = ?')
        vals.push(val, val)
        continue
      }
      sets.push(`${key} = ?`)
      vals.push(val === '' ? null : val)
    }
    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: '没有可应用的字段' })
    }
    if (nicknameTo) {
      const [conflict] = await pool.query(
        'SELECT id FROM members WHERE (username = ? OR nickname = ?) AND id != ? LIMIT 1',
        [nicknameTo, nicknameTo, row.student_member_id]
      )
      if (conflict.length > 0) {
        return res.status(400).json({ success: false, message: '昵称已被其他成员占用' })
      }
    }
    if (qqTo) {
      const [conflict] = await pool.query(
        'SELECT id FROM members WHERE qq = ? AND id != ? LIMIT 1',
        [qqTo, row.student_member_id]
      )
      if (conflict.length > 0) {
        return res.status(400).json({ success: false, message: 'QQ号已被占用' })
      }
    }

    vals.push(row.student_member_id)
    await pool.query(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`, vals)

    if (Object.prototype.hasOwnProperty.call(changes, 'last_training_date')) {
      const trainDate = toMySQLDate(resolveTo(changes.last_training_date))
      const rawLtd = changes.last_training_date
      const previousLastTrainingDate =
        rawLtd && typeof rawLtd === 'object' && !Array.isArray(rawLtd)
          ? toMySQLDate(rawLtd.from)
          : null
      if (trainDate) {
        try {
          const { syncProxyCheckinFromTrainingDate } = await import('../utils/checkinService.js')
          await syncProxyCheckinFromTrainingDate(row.student_member_id, trainDate, {
            type: 'admin',
            id: req.admin.id,
            name: req.admin.name || req.admin.username || '管理员',
            previousLastTrainingDate,
          })
        } catch (e) {
          console.warn('[assistant] approve edit sync checkin', e.message)
        }
      }
    }

    await pool.query(
      `UPDATE pending_member_edits
       SET status = '已通过', reviewed_by_admin_id = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [req.admin.id, id]
    )
    res.json({ success: true, message: '已通过信息修改' })
  } catch (error) {
    console.error('审批信息修改失败:', error)
    res.status(500).json({ success: false, message: '审批失败' })
  }
})

router.put('/admin/black-points/:id/review', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const approve = req.body.status === '已通过'
    const [[row]] = await pool.query(
      `SELECT * FROM pending_black_points WHERE id = ? AND status = '待审批'`,
      [id]
    )
    if (!row) return res.status(404).json({ success: false, message: '申请不存在' })

    if (!approve) {
      await pool.query(
        `UPDATE pending_black_points
         SET status = '已驳回', reject_reason = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.body.reject_reason || null, req.admin.id, id]
      )
      return res.json({ success: true, message: '已驳回' })
    }

    const [[student]] = await pool.query(
      'SELECT id, nickname, qq FROM members WHERE id = ?',
      [row.student_member_id]
    )
    if (!student) return res.status(404).json({ success: false, message: '学员不存在' })

    const [[assistant]] = await pool.query(
      'SELECT nickname FROM members WHERE id = ?',
      [row.assistant_member_id]
    )
    const recorderName = assistant?.nickname
      ? `${assistant.nickname}（助教提报）`
      : '助教提报'
    const [insert] = await pool.query(
      `INSERT INTO black_point_records
        (member_id, member_name, qq, reason, register_date, recorder_id, recorder_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, '生效中')`,
      [
        student.id,
        student.nickname,
        student.qq,
        row.reason,
        toMySQLDate(row.register_date) || toMySQLDate(new Date()),
        req.admin.id,
        recorderName,
      ]
    )
    await pool.query(
      `UPDATE pending_black_points
       SET status = '已通过', created_black_point_id = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [insert.insertId, req.admin.id, id]
    )
    res.json({ success: true, message: '已通过黑点登记' })
  } catch (error) {
    console.error('审批黑点失败:', error)
    res.status(500).json({ success: false, message: '审批失败' })
  }
})

router.put('/admin/leaves/:id/review', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const approve = req.body.status === '已通过'
    const [[row]] = await pool.query(
      `SELECT * FROM pending_leaves WHERE id = ? AND status = '待审批'`,
      [id]
    )
    if (!row) return res.status(404).json({ success: false, message: '申请不存在' })

    if (!approve) {
      await pool.query(
        `UPDATE pending_leaves
         SET status = '已驳回', reject_reason = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.body.reject_reason || null, req.admin.id, id]
      )
      return res.json({ success: true, message: '已驳回' })
    }

    const [[student]] = await pool.query(
      'SELECT id, nickname, qq FROM members WHERE id = ?',
      [row.student_member_id]
    )
    if (!student) return res.status(404).json({ success: false, message: '学员不存在' })

    const start = toMySQLDate(row.start_date)
    const end = toMySQLDate(row.end_date)
    const [[dateDiff]] = await pool.query('SELECT DATEDIFF(?, ?) AS total_days', [end, start])
    const totalDays = (dateDiff?.total_days ?? 0) + 1

    const [insert] = await pool.query(
      `INSERT INTO leave_records
        (member_id, member_name, qq, reason, start_date, end_date, total_days, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, '请假中', ?)`,
      [
        student.id,
        student.nickname,
        student.qq,
        row.reason || '',
        start,
        end,
        totalDays,
        req.admin.id,
      ]
    )
    await pool.query(`UPDATE members SET status = '请假中' WHERE id = ?`, [student.id])
    await pool.query(
      `UPDATE pending_leaves
       SET status = '已通过', created_leave_id = ?, reviewed_by_admin_id = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [insert.insertId, req.admin.id, id]
    )
    res.json({ success: true, message: '已通过请假登记' })
  } catch (error) {
    console.error('审批请假失败:', error)
    res.status(500).json({ success: false, message: '审批失败' })
  }
})

router.get('/admin/assignments-by-assistant/:id', requireAdmin, async (req, res) => {
  try {
    const assistantId = Number(req.params.id)
    const today = shanghaiToday()
    const [rows] = await pool.query(
      `SELECT a.*, m.nickname AS student_name, m.qq AS student_qq, m.stage_role, m.avatar
       FROM assistant_student_assignments a
       LEFT JOIN members m ON m.id = a.student_member_id
       WHERE a.assistant_member_id = ? AND a.status IN ('已通过', '待审批')
       ORDER BY a.status, a.updated_at DESC`,
      [assistantId]
    )
    const [daily] = await pool.query(
      `SELECT d.*, m.nickname AS student_name, m.qq AS student_qq, m.stage_role, m.avatar
       FROM assistant_daily_assignments d
       LEFT JOIN members m ON m.id = d.student_member_id
       WHERE d.assistant_member_id = ? AND d.assign_date = ?
       ORDER BY d.created_at DESC`,
      [assistantId, today]
    )
    res.json({ success: true, data: rows, daily, meta: { today } })
  } catch (error) {
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

/** 管理端：分配当日临时学员（上海日历日有效，过零点失效） */
router.post('/admin/daily-assignments', requireAdmin, async (req, res) => {
  try {
    const assistantId = Number(req.body.assistant_member_id)
    const studentId = Number(req.body.student_member_id)
    if (!assistantId || !studentId) {
      return res.status(400).json({ success: false, message: '参数不完整' })
    }
    const [[asst]] = await pool.query(
      'SELECT id, stage_role, is_ziye_assistant FROM members WHERE id = ?',
      [assistantId]
    )
    if (!asst || !isZiyeAssistantMember(asst)) {
      return res.status(400).json({ success: false, message: '助教不存在' })
    }
    const [[student]] = await pool.query(
      'SELECT id, status FROM members WHERE id = ?',
      [studentId]
    )
    if (!student || student.status === '已退队') {
      return res.status(404).json({ success: false, message: '学员不存在' })
    }
    if (await isPermanentStudent(assistantId, studentId)) {
      return res.status(400).json({ success: false, message: '该学员已是长期归属，无需当日分配' })
    }
    const today = shanghaiToday()
    await pool.query(
      `INSERT INTO assistant_daily_assignments
        (assistant_member_id, student_member_id, assign_date, assigned_by_admin_id, remarks)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         assigned_by_admin_id = VALUES(assigned_by_admin_id),
         remarks = VALUES(remarks)`,
      [assistantId, studentId, today, req.admin.id, req.body.remarks || null]
    )
    const [[row]] = await pool.query(
      `SELECT id FROM assistant_daily_assignments
       WHERE assistant_member_id = ? AND student_member_id = ? AND assign_date = ?`,
      [assistantId, studentId, today]
    )
    res.json({
      success: true,
      message: `已分配为当日学员（${today}，过零点失效）`,
      data: { id: row?.id, assign_date: today },
    })
  } catch (error) {
    console.error('分配当日学员失败:', error)
    res.status(500).json({ success: false, message: '分配失败' })
  }
})

router.delete('/admin/daily-assignments/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM assistant_daily_assignments WHERE id = ?', [req.params.id])
    res.json({ success: true, message: '已取消当日分配' })
  } catch (error) {
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

router.get('/admin/defaults', requireAdmin, (_req, res) => {
  res.json({ success: true, data: DEFAULT_ASSISTANT_PERMISSIONS })
})

export default router
