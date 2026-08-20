/** 催促名单与 badge 共用的阶段列表 */
export const TRAINING_STAGES = ['未新训', '新训初期', '新训一期', '新训二期', '新训三期', '新训准考']

/** 训练催促：剩余 N 天起进入名单（原先为 7） */
export const TRAINING_WARN_DAYS = 3

/** 成员仍有未最终结束的请假（请假中 / 待结束审批）——不应进训练催促 */
export const ACTIVE_LEAVE_EXISTS = `
  SELECT 1 FROM leave_records al
  WHERE al.member_id = m.id
    AND al.status IN ('请假中', '待结束审批')
`

/** 成员处于请假结束缓冲期内（审批通过后 7 天内） */
export const LEAVE_BUFFER_EXISTS = `
  SELECT 1 FROM leave_records lr
  WHERE lr.member_id = m.id
    AND lr.status = '已结束'
    AND lr.buffer_start_date IS NOT NULL
    AND DATEDIFF(CURDATE(), lr.buffer_start_date) < 7
`

/** 未训天数达到催促预警阈值（全局固定 threshold，占位符 2 次） */
export const TRAINING_INACTIVITY_THRESHOLD = `
  (
    (m.last_training_date IS NOT NULL AND DATEDIFF(CURDATE(), m.last_training_date) >= ?)
    OR (m.last_training_date IS NULL AND m.join_date IS NOT NULL AND DATEDIFF(CURDATE(), m.join_date) >= ?)
  )
`

/** @param {number} warnDays 距离超时还剩 ≤ warnDays 天进入名单 */
function sanitizeWarnDays(warnDays) {
  const n = Math.floor(Number(warnDays))
  if (!Number.isFinite(n)) return TRAINING_WARN_DAYS
  return Math.min(30, Math.max(0, n))
}

/** 未训天数达到该成员的有效超时预警线（占位符 2 次） */
export function buildPerMemberThresholdSql(warnDays = TRAINING_WARN_DAYS) {
  const w = sanitizeWarnDays(warnDays)
  return `
  (
    (m.last_training_date IS NOT NULL AND DATEDIFF(CURDATE(), m.last_training_date) >= GREATEST(COALESCE(rl.custom_timeout_days, ?) - ${w}, 0))
    OR (m.last_training_date IS NULL AND m.join_date IS NOT NULL AND DATEDIFF(CURDATE(), m.join_date) >= GREATEST(COALESCE(rl.custom_timeout_days, ?) - ${w}, 0))
  )
`
}

/** 按全局超时标准进入预警窗（忽略自定义，占位符 2 次） */
export function buildGlobalThresholdSql(warnDays = TRAINING_WARN_DAYS) {
  const w = sanitizeWarnDays(warnDays)
  return `
  (
    (m.last_training_date IS NOT NULL AND DATEDIFF(CURDATE(), m.last_training_date) >= GREATEST(? - ${w}, 0))
    OR (m.last_training_date IS NULL AND m.join_date IS NOT NULL AND DATEDIFF(CURDATE(), m.join_date) >= GREATEST(? - ${w}, 0))
  )
`
}

/**
 * 进入训练催促名单。
 * - includeCustomExtended=true（倒计时模式）：有效超时已进预警，或有自定义延期但仍按全局标准落在预警窗（方便管理查看延期的人）
 * - includeCustomExtended=false（踢人周期）：只按成员有效超时（含自定义）判断本轮是否会超期，不拉入「延期中」的人
 * 占位符：includeCustomExtended 时 4 次，否则 2 次
 */
export function buildTrainingReminderEligibleSql(warnDays = TRAINING_WARN_DAYS, opts = {}) {
  const includeCustomExtended = opts.includeCustomExtended !== false
  const per = buildPerMemberThresholdSql(warnDays)
  if (!includeCustomExtended) {
    return `(${per})`
  }
  const global = buildGlobalThresholdSql(warnDays)
  return `
  (
    ${per}
    OR (
      rl.custom_timeout_days IS NOT NULL
      AND ${global}
    )
  )
`
}

/** 是否为「自定义延期」（占位符 2 次） */
export function buildIsCustomExtendedSql(warnDays = TRAINING_WARN_DAYS) {
  const per = buildPerMemberThresholdSql(warnDays)
  return `
  CASE
    WHEN rl.custom_timeout_days IS NOT NULL
      AND NOT ${per}
    THEN 1
    ELSE 0
  END
`
}

/** @deprecated 兼容旧引用，等价于 warnDays=TRAINING_WARN_DAYS */
export const TRAINING_INACTIVITY_THRESHOLD_PER_MEMBER = buildPerMemberThresholdSql(TRAINING_WARN_DAYS)
export const TRAINING_INACTIVITY_THRESHOLD_GLOBAL = buildGlobalThresholdSql(TRAINING_WARN_DAYS)
export const TRAINING_REMINDER_ELIGIBLE = buildTrainingReminderEligibleSql(TRAINING_WARN_DAYS)
export const IS_CUSTOM_EXTENDED_SQL = buildIsCustomExtendedSql(TRAINING_WARN_DAYS)

/** 请假缓冲剩余天数（自结束审批通过日起算 7 天，与训练超时倒计时独立） */
export const BUFFER_REMAINING_DAYS_SQL = `GREATEST(0, 7 - DATEDIFF(CURDATE(), lr.buffer_start_date))`

/** 距离超时天数计算（defaultTimeoutDays 占位符一次） */
export const DAYS_UNTIL_TIMEOUT_SQL = `
  CASE
    WHEN rl.custom_timeout_days IS NOT NULL THEN
      rl.custom_timeout_days - CASE
        WHEN m.last_training_date IS NOT NULL THEN DATEDIFF(CURDATE(), m.last_training_date)
        ELSE DATEDIFF(CURDATE(), m.join_date)
      END
    ELSE
      ? - CASE
        WHEN m.last_training_date IS NOT NULL THEN DATEDIFF(CURDATE(), m.last_training_date)
        ELSE DATEDIFF(CURDATE(), m.join_date)
      END
  END
`
