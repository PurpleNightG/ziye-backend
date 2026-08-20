import { pool } from '../config/database.js'
import {
  TRAINING_STAGES,
  ACTIVE_LEAVE_EXISTS,
  LEAVE_BUFFER_EXISTS,
  DAYS_UNTIL_TIMEOUT_SQL,
  BUFFER_REMAINING_DAYS_SQL,
  TRAINING_WARN_DAYS,
  buildTrainingReminderEligibleSql,
  buildIsCustomExtendedSql,
} from './reminderQuery.js'
import { getKickCycleInfo } from './kickCycle.js'
import { getSetting } from '../routes/settings.js'
import {
  FORMAL_MEMBER_STAGES,
  loadFormalUse180Set,
} from './formalAttendancePolicy.js'
import { loadReminderRulesConfig } from './reminderRulesConfig.js'

export async function loadReminderConfig() {
  const kickWeekdayRow = await getSetting('reminder_kick_weekday', '1')
  const leadRow = await getSetting('reminder_kick_lead_days', '3')
  const modeRow = await getSetting('reminder_display_mode', 'remaining')
  const rules = await loadReminderRulesConfig()

  const [[dateRow]] = await pool.query('SELECT CURDATE() AS today')
  const raw = dateRow.today
  let todayIso
  if (raw instanceof Date) {
    const y = raw.getFullYear()
    const m = String(raw.getMonth() + 1).padStart(2, '0')
    const d = String(raw.getDate()).padStart(2, '0')
    todayIso = `${y}-${m}-${d}`
  } else {
    todayIso = String(raw).slice(0, 10)
  }

  const kickWeekday = parseInt(kickWeekdayRow.setting_value, 10) || 1
  const leadDays = parseInt(leadRow.setting_value, 10) || 3
  const kickInfo = getKickCycleInfo(todayIso, kickWeekday, leadDays)

  return {
    defaultTimeoutDays: rules.training.defaultTimeoutDays,
    formalTimeoutDays: rules.training.formalTimeoutDays,
    trainingStages: rules.training.stages?.length ? rules.training.stages : TRAINING_STAGES,
    trainingWarnDays: rules.training.warnDays ?? TRAINING_WARN_DAYS,
    formalStages: rules.training.formalStages?.length ? rules.training.formalStages : FORMAL_MEMBER_STAGES,
    rulesConfig: rules,
    displayMode: modeRow.setting_value === 'kick_cycle' ? 'kick_cycle' : 'remaining',
    kickInfo,
    todayIso,
  }
}

/**
 * @param {string[]} stages
 * @param {number} defaultTimeoutDays
 * @param {number} warnDays
 * @param {{ includeCustomExtended?: boolean, includeLeaveBuffer?: boolean, excludeMemberIds?: Set<number>|number[] }} [opts]
 */
async function queryTrainingRemindersForStages(stages, defaultTimeoutDays, warnDays, opts = {}) {
  if (!stages.length) return []

  const includeCustomExtended = opts.includeCustomExtended !== false
  /** 踢人周期名单不含请假缓冲（缓冲期内不参与本轮踢人） */
  const includeLeaveBuffer = opts.includeLeaveBuffer !== false
  const excludeIds = [...(opts.excludeMemberIds || [])]
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0)

  const stagePlaceholders = stages.map(() => '?').join(', ')
  const eligibleSql = buildTrainingReminderEligibleSql(warnDays, { includeCustomExtended })
  const extendedSql = buildIsCustomExtendedSql(warnDays)
  const eligibleParams = includeCustomExtended
    ? [defaultTimeoutDays, defaultTimeoutDays, defaultTimeoutDays, defaultTimeoutDays]
    : [defaultTimeoutDays, defaultTimeoutDays]
  const extendedParams = [defaultTimeoutDays, defaultTimeoutDays]
  const excludeSql = excludeIds.length
    ? `AND m.id NOT IN (${excludeIds.map(() => '?').join(',')})`
    : ''

  const leaveBufferSelect = `
      SELECT
        m.id AS id,
        m.id AS member_id,
        m.nickname AS member_name,
        m.avatar AS avatar,
        m.qq,
        m.stage_role,
        m.last_training_date,
        CASE
          WHEN m.last_training_date IS NOT NULL THEN DATEDIFF(CURDATE(), m.last_training_date)
          ELSE DATEDIFF(CURDATE(), m.join_date)
        END AS days_without_training,
        rl.custom_timeout_days,
        ${BUFFER_REMAINING_DAYS_SQL} AS days_until_timeout,
        1 AS is_leave_buffer,
        ${BUFFER_REMAINING_DAYS_SQL} AS buffer_remaining_days,
        ${extendedSql} AS is_custom_extended
      FROM members m
      INNER JOIN leave_records lr ON lr.id = (
        SELECT id FROM leave_records
        WHERE member_id = m.id
          AND status = '已结束'
          AND buffer_start_date IS NOT NULL
          AND DATEDIFF(CURDATE(), buffer_start_date) < 7
        ORDER BY buffer_start_date DESC
        LIMIT 1
      )
      LEFT JOIN reminder_list rl ON m.id = rl.member_id
      LEFT JOIN retention_records ret ON m.id = ret.member_id
      WHERE m.status NOT IN ('已退队', '请假中', '其他')
        AND m.stage_role IN (${stagePlaceholders})
        ${excludeSql}
        AND ret.id IS NULL
        AND NOT EXISTS (${ACTIVE_LEAVE_EXISTS})
        AND ${eligibleSql}

      UNION ALL
  `

  const [rows] = await pool.query(`
    SELECT * FROM (
      ${includeLeaveBuffer ? leaveBufferSelect : ''}
      SELECT
        m.id AS id,
        m.id AS member_id,
        m.nickname AS member_name,
        m.avatar AS avatar,
        m.qq,
        m.stage_role,
        m.last_training_date,
        CASE
          WHEN m.last_training_date IS NOT NULL THEN DATEDIFF(CURDATE(), m.last_training_date)
          ELSE DATEDIFF(CURDATE(), m.join_date)
        END AS days_without_training,
        rl.custom_timeout_days,
        ${DAYS_UNTIL_TIMEOUT_SQL} AS days_until_timeout,
        0 AS is_leave_buffer,
        NULL AS buffer_remaining_days,
        ${extendedSql} AS is_custom_extended
      FROM members m
      LEFT JOIN reminder_list rl ON m.id = rl.member_id
      LEFT JOIN retention_records ret ON m.id = ret.member_id
      WHERE m.status NOT IN ('已退队', '请假中', '其他')
        AND m.stage_role IN (${stagePlaceholders})
        ${excludeSql}
        AND ${eligibleSql}
        AND ret.id IS NULL
        AND NOT EXISTS (${ACTIVE_LEAVE_EXISTS})
        AND NOT EXISTS (${LEAVE_BUFFER_EXISTS})
    ) combined
    ORDER BY is_leave_buffer DESC, is_custom_extended ASC, days_without_training DESC
  `, [
    ...(includeLeaveBuffer
      ? [...extendedParams, ...stages, ...excludeIds, ...eligibleParams]
      : []),
    defaultTimeoutDays,
    ...extendedParams,
    ...stages,
    ...excludeIds,
    ...eligibleParams,
  ])

  return rows
}

/**
 * @param {number} defaultTimeoutDays
 * @param {number} warnDays 还剩 ≤ warnDays 天进入名单
 * @param {{ includeCustomExtended?: boolean, includeLeaveBuffer?: boolean, formalTimeoutDays?: number, formalUse180Ids?: Set<number>|number[] }} [opts]
 */
export async function queryTrainingReminders(defaultTimeoutDays, warnDays, opts = {}) {
  const includeCustomExtended = opts.includeCustomExtended !== false
  const includeLeaveBuffer = opts.includeLeaveBuffer !== false
  const formalTimeoutDays =
    opts.formalTimeoutDays != null
      ? Number(opts.formalTimeoutDays) || 0
      : await loadFormalTimeoutDays()
  const formalUse180Ids =
    opts.formalUse180Ids != null
      ? opts.formalUse180Ids
      : (formalTimeoutDays > 0 ? await loadFormalUse180Set() : new Set())

  const rules = await loadReminderRulesConfig()
  const traineeStages = rules.training.stages?.length ? rules.training.stages : TRAINING_STAGES
  const formalStages = rules.training.formalStages?.length
    ? rules.training.formalStages
    : FORMAL_MEMBER_STAGES

  const traineeRows = await queryTrainingRemindersForStages(
    traineeStages,
    defaultTimeoutDays,
    warnDays,
    { includeCustomExtended, includeLeaveBuffer },
  )

  let formalRows = []
  if (formalTimeoutDays > 0) {
    formalRows = await queryTrainingRemindersForStages(
      formalStages,
      formalTimeoutDays,
      warnDays,
      {
        includeCustomExtended,
        includeLeaveBuffer,
        excludeMemberIds: formalUse180Ids,
      },
    )
    formalRows = formalRows.map((r) => ({
      ...r,
      is_formal_member_attendance: 1,
      formal_timeout_days: formalTimeoutDays,
    }))
  }

  const byId = new Map()
  for (const row of [...traineeRows, ...formalRows]) {
    byId.set(Number(row.member_id || row.id), row)
  }
  return [...byId.values()].sort((a, b) => {
    const buf = (Number(b.is_leave_buffer) || 0) - (Number(a.is_leave_buffer) || 0)
    if (buf) return buf
    const ext = (Number(a.is_custom_extended) || 0) - (Number(b.is_custom_extended) || 0)
    if (ext) return ext
    return (Number(b.days_without_training) || 0) - (Number(a.days_without_training) || 0)
  })
}

/**
 * 学员端：自己的训练催促状态。
 * 正式队员在开启「正式队员考勤时间」后，即使尚未进入管理端预警窗（还剩>3天），
 * 也返回倒计时，以便首页弹出训练催促（与考勤弹窗「始终可见」一致）。
 */
export async function queryTrainingReminderForMember(memberId, defaultTimeoutDays, warnDays, opts = {}) {
  const id = Number(memberId)
  if (!id) return null

  const rows = await queryTrainingReminders(defaultTimeoutDays, warnDays, opts)
  const hit = rows.find((r) => Number(r.member_id) === id || Number(r.id) === id)
  if (hit) return hit

  const formalTimeoutDays =
    opts.formalTimeoutDays != null
      ? Number(opts.formalTimeoutDays) || 0
      : await loadFormalTimeoutDays()
  if (!(formalTimeoutDays > 0)) return null

  const use180Set =
    opts.formalUse180Ids != null
      ? new Set([...opts.formalUse180Ids].map(Number))
      : await loadFormalUse180Set()
  if (use180Set.has(id)) return null

  const [[m]] = await pool.query(
    `SELECT
       m.id, m.nickname, m.avatar, m.qq, m.stage_role, m.status,
       m.last_training_date, m.join_date,
       rl.custom_timeout_days,
       CASE WHEN ret.id IS NOT NULL THEN 1 ELSE 0 END AS in_retention
     FROM members m
     LEFT JOIN reminder_list rl ON m.id = rl.member_id
     LEFT JOIN retention_records ret ON m.id = ret.member_id
     WHERE m.id = ?
     LIMIT 1`,
    [id]
  )
  if (!m) return null
  const formalStages = (await loadReminderRulesConfig()).training.formalStages || FORMAL_MEMBER_STAGES
  if (!formalStages.includes(m.stage_role)) return null
  if (m.in_retention) return null
  if (['已退队', '请假中', '其他'].includes(m.status)) return null

  const [[activeLeave]] = await pool.query(
    `SELECT 1 AS ok FROM leave_records
     WHERE member_id = ? AND status IN ('请假中', '待结束审批')
     LIMIT 1`,
    [id]
  )
  if (activeLeave) return null

  const [[bufferRow]] = await pool.query(
    `SELECT GREATEST(0, 7 - DATEDIFF(CURDATE(), buffer_start_date)) AS buffer_remaining_days
     FROM leave_records
     WHERE member_id = ?
       AND status = '已结束'
       AND buffer_start_date IS NOT NULL
       AND DATEDIFF(CURDATE(), buffer_start_date) < 7
     ORDER BY buffer_start_date DESC
     LIMIT 1`,
    [id]
  )

  const [[diffRow]] = await pool.query(
    `SELECT
       CASE
         WHEN m.last_training_date IS NOT NULL THEN DATEDIFF(CURDATE(), m.last_training_date)
         WHEN m.join_date IS NOT NULL THEN DATEDIFF(CURDATE(), m.join_date)
         ELSE 0
       END AS days_without_training
     FROM members m WHERE m.id = ?`,
    [id]
  )
  const daysWithout = Number(diffRow?.days_without_training) || 0
  const effectiveTimeout = m.custom_timeout_days != null
    ? Number(m.custom_timeout_days)
    : formalTimeoutDays
  const daysUntil = effectiveTimeout - daysWithout
  const isCustomExtended =
    m.custom_timeout_days != null && daysUntil > warnDays ? 1 : 0

  if (bufferRow) {
    return {
      id: m.id,
      member_id: m.id,
      member_name: m.nickname,
      avatar: m.avatar,
      qq: m.qq,
      stage_role: m.stage_role,
      last_training_date: m.last_training_date,
      days_without_training: daysWithout,
      custom_timeout_days: m.custom_timeout_days,
      days_until_timeout: Number(bufferRow.buffer_remaining_days) || 0,
      is_leave_buffer: 1,
      buffer_remaining_days: Number(bufferRow.buffer_remaining_days) || 0,
      is_custom_extended: 0,
      is_formal_member_attendance: 1,
      formal_timeout_days: formalTimeoutDays,
    }
  }

  return {
    id: m.id,
    member_id: m.id,
    member_name: m.nickname,
    avatar: m.avatar,
    qq: m.qq,
    stage_role: m.stage_role,
    last_training_date: m.last_training_date,
    days_without_training: daysWithout,
    custom_timeout_days: m.custom_timeout_days,
    days_until_timeout: daysUntil,
    is_leave_buffer: 0,
    buffer_remaining_days: null,
    is_custom_extended: isCustomExtended,
    is_formal_member_attendance: 1,
    formal_timeout_days: formalTimeoutDays,
  }
}

/** 按显示模式取训练催促人数（与列表接口一致） */
export async function countTrainingReminders(modeOverride = null) {
  const cfg = await loadReminderConfig()
  const mode = modeOverride === 'kick_cycle' || modeOverride === 'remaining'
    ? modeOverride
    : cfg.displayMode

  const warnDays = cfg.trainingWarnDays ?? TRAINING_WARN_DAYS

  if (mode === 'kick_cycle') {
    if (!cfg.kickInfo.inWindow) return { count: 0, mode, cfg }
    const rows = await queryTrainingReminders(cfg.defaultTimeoutDays, cfg.kickInfo.daysUntilKick, {
      includeCustomExtended: false,
      includeLeaveBuffer: false,
      formalTimeoutDays: cfg.formalTimeoutDays,
    })
    return { count: rows.length, mode, cfg }
  }

  const rows = await queryTrainingReminders(cfg.defaultTimeoutDays, warnDays, {
    includeCustomExtended: true,
    formalTimeoutDays: cfg.formalTimeoutDays,
  })
  return { count: rows.length, mode, cfg }
}
