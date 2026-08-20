/**
 * 考勤催促：按 reminder_rules_config 规则链计算
 * - until_stage：从锚点起在 N 天内达到目标阶段
 * - training_idle：指定阶段自上次训练起的闲置天数
 */

import {
  formatRuleLabel,
  loadReminderRulesConfig,
  resolveRuleBadge,
  resolveRuleBadgeColor,
} from './reminderRulesConfig.js'

/** @deprecated 默认常量，实际以配置为准 */
export const PHASE3_DEADLINE_DAYS = 60
export const FORMAL_DEADLINE_DAYS = 45
export const MAX_TRACK_DAYS = PHASE3_DEADLINE_DAYS + FORMAL_DEADLINE_DAYS
export const FORMAL_IDLE_DAYS = 180
export const ATTENDANCE_WARN_DAYS = 7

function toDateOnly(v) {
  if (!v) return null
  if (v instanceof Date) {
    return new Date(v.getFullYear(), v.getMonth(), v.getDate())
  }
  const s = String(v).slice(0, 10)
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function datediff(a, b) {
  const da = toDateOnly(a)
  const db = toDateOnly(b)
  if (!da || !db) return 0
  return Math.round((da - db) / 86400000)
}

/** 区间 [rangeStart, rangeEnd] 与请假记录的重叠天数 */
export function leaveDaysInRange(leaves, rangeStart, rangeEnd, today = new Date()) {
  const rs = toDateOnly(rangeStart)
  const re = toDateOnly(rangeEnd) || toDateOnly(today)
  if (!rs || !re || re < rs) return 0

  let total = 0
  for (const leave of leaves || []) {
    const ls = toDateOnly(leave.start_date)
    if (!ls) continue
    let le = toDateOnly(leave.end_date)
    if (leave.status === '请假中' || leave.status === '待结束审批') {
      le = re
    }
    if (!le) continue
    const start = ls > rs ? ls : rs
    const end = le < re ? le : re
    if (end >= start) {
      total += datediff(end, start)
    }
  }
  return Math.max(0, total)
}

export function effectiveElapsedDays(fromDate, toDate, leaves) {
  const raw = datediff(toDate, fromDate)
  if (raw <= 0) return 0
  const paused = leaveDaysInRange(leaves, fromDate, toDate, toDate)
  return Math.max(0, raw - paused)
}

function stageInList(stage, list) {
  return Array.isArray(list) && list.includes(stage)
}

/** 供阶段变更时写入 milestone：合并所有规则的 milestoneStages */
export function getMilestoneStagesFromConfig(config) {
  const set = new Set()
  for (const rule of config?.attendance?.rules || []) {
    if (rule.type !== 'until_stage') continue
    for (const s of rule.milestoneStages || []) set.add(s)
  }
  if (set.size === 0) {
    ;['新训三期', '新训准考', '紫夜', '紫夜尖兵', '紫夜助教',
      '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师'].forEach((s) => set.add(s))
  }
  return set
}

export function isPhase3OrAbove(stage, config = null) {
  if (config) {
    const milestones = getMilestoneStagesFromConfig(config)
    return milestones.has(stage)
  }
  return getMilestoneStagesFromConfig(null).has(stage)
}

export function isExamOrAbove(stage, config = null) {
  if (config) {
    for (const rule of config.attendance?.rules || []) {
      if (rule.reasonCode === 'to_exam' || rule.id === 'to_exam') {
        return stageInList(stage, rule.doneWhenStages)
      }
    }
  }
  return ['新训准考', '紫夜', '紫夜尖兵', '紫夜助教',
    '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师'].includes(stage)
}

export function isFormalOrAbove(stage, config = null) {
  return isExamOrAbove(stage, config)
}

export function isFormalMember(stage, config = null) {
  const stages = config?.training?.formalStages
  if (Array.isArray(stages) && stages.length) return stages.includes(stage)
  return stage === '紫夜' || stage === '紫夜尖兵'
}

function resolveStartDate(rule, joinDate, phase3At, lastTraining) {
  switch (rule.startAnchor) {
    case 'phase3_reached_at':
      // 调用方已确认已达里程碑；缺日期时回退加入日
      return phase3At || joinDate
    case 'last_training_date':
      return lastTraining || joinDate
    case 'join_date':
    default:
      return joinDate
  }
}

/**
 * @param {object} member
 * @param {object[]} leaves
 * @param {object} opts
 * @param {object} opts.rulesConfig loadReminderRulesConfig() 结果
 */
export function computeAttendanceForMember(member, leaves, opts = {}) {
  const {
    today = new Date(),
    ignored = false,
    inRetention = false,
    showAll = false,
    overrides = {},
    formalTimeoutDays = 0,
    useFormal180 = false,
    rulesConfig = null,
  } = opts

  if (inRetention) return null
  if (member.status === '其他' || member.status === '已退队') return null

  const joinDate = toDateOnly(member.join_date)
  if (!joinDate) return null

  const hasActiveLeave = (leaves || []).some(
    (l) => l.status === '请假中' || l.status === '待结束审批'
  )
  const onLeave = member.status === '请假中' || hasActiveLeave
  const stage = member.stage_role
  const phase3At = toDateOnly(member.phase3_reached_at)
  const lastTraining = toDateOnly(member.last_training_date) || joinDate

  const warnDays = rulesConfig?.attendance?.warnDays ?? ATTENDANCE_WARN_DAYS
  const rules = rulesConfig?.attendance?.rules || []
  const formalStages = rulesConfig?.training?.formalStages || ['紫夜', '紫夜尖兵']
  const effectiveFormalTimeout = formalTimeoutDays > 0
    ? formalTimeoutDays
    : (rulesConfig?.training?.formalTimeoutDays || 0)

  const clocks = []

  for (const rule of rules) {
    if (!rule.enabled) continue

    if (rule.type === 'training_idle') {
      const activeStages = rule.activeWhenStages?.length ? rule.activeWhenStages : formalStages
      if (!stageInList(stage, activeStages)) continue
      // 开启正式队员短周期且未「取消考勤」时，跳过本条（改走训练催促常驻倒计时）
      if (rule.skipWhenFormalShortCycle !== false) {
        if (effectiveFormalTimeout > 0 && !useFormal180) continue
      }

      const elapsed = effectiveElapsedDays(lastTraining, today, leaves)
      const deadline = rule.deadlineDays
      clocks.push({
        reason_code: rule.reasonCode || rule.id,
        reason_title: resolveRuleBadge(rule),
        reason_color: resolveRuleBadgeColor(rule),
        reason_label: formatRuleLabel(rule, { deadline }),
        deadline_days: deadline,
        elapsed_days: elapsed,
        remaining_days: deadline - elapsed,
        paused: onLeave,
      })
      continue
    }

    // until_stage
    if (stageInList(stage, rule.doneWhenStages)) continue

    if (rule.startAnchor === 'phase3_reached_at') {
      const started = !!(phase3At || isPhase3OrAbove(stage, rulesConfig))
      if (!started) continue
    }

    const start = resolveStartDate(rule, joinDate, phase3At, lastTraining)
    if (!start) continue

    const elapsed = effectiveElapsedDays(start, today, leaves)
    const deadline = rule.deadlineDays
    let remaining = deadline - elapsed

    if (rule.capFromJoinDays != null) {
      const elapsedFromJoin = effectiveElapsedDays(joinDate, today, leaves)
      const remainCap = rule.capFromJoinDays - elapsedFromJoin
      remaining = Math.min(remaining, remainCap)
    }

    clocks.push({
      reason_code: rule.reasonCode || rule.id,
      reason_title: resolveRuleBadge(rule),
      reason_color: resolveRuleBadgeColor(rule),
      reason_label: formatRuleLabel(rule, {
        deadline,
        cap: rule.capFromJoinDays,
      }),
      deadline_days: deadline,
      elapsed_days: elapsed,
      remaining_days: remaining,
      paused: onLeave,
    })
  }

  if (clocks.length === 0) return null

  for (const clock of clocks) {
    const custom =
      overrides[clock.reason_code] ??
      (clock.reason_code === 'to_exam' ? overrides.to_formal : undefined)
    if (custom != null && Number(custom) > 0) {
      const customDays = Number(custom)
      clock.deadline_days = customDays
      clock.remaining_days = customDays - clock.elapsed_days
      clock.has_custom_deadline = true
    }
  }

  clocks.sort((a, b) => a.remaining_days - b.remaining_days)
  const primary = clocks[0]
  const remaining_days = primary.remaining_days
  const hasCustom = clocks.some((c) => c.has_custom_deadline)

  const inWarnWindow = remaining_days <= warnDays
  if (!showAll && !inWarnWindow && !ignored && !hasCustom) return null
  if (ignored && !showAll) return null
  if (onLeave && !showAll) return null

  return {
    member_id: member.id,
    member_name: member.nickname,
    avatar: member.avatar || null,
    qq: member.qq,
    stage_role: stage,
    join_date: member.join_date,
    last_training_date: member.last_training_date,
    phase3_reached_at: member.phase3_reached_at,
    status: member.status,
    ignored,
    paused: onLeave,
    reason_code: primary.reason_code,
    reason_title: primary.reason_title,
    reason_color: primary.reason_color,
    reason_label: primary.reason_label,
    remaining_days,
    elapsed_days: primary.elapsed_days,
    deadline_days: primary.deadline_days,
    has_custom_deadline: !!primary.has_custom_deadline,
    custom_deadline_days: primary.has_custom_deadline ? primary.deadline_days : null,
    formal_use_180: !!useFormal180 && primary.reason_code === 'formal_idle',
    reasons: clocks,
  }
}

export async function ensurePhase3ReachedAt(pool, memberId, newStage, config = null) {
  const cfg = config || await loadReminderRulesConfig()
  const milestones = getMilestoneStagesFromConfig(cfg)
  if (!milestones.has(newStage)) return
  await pool.query(
    `UPDATE members
     SET phase3_reached_at = COALESCE(phase3_reached_at, CURDATE())
     WHERE id = ?`,
    [memberId]
  )
}
