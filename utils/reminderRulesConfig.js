/**
 * 催促 / 考勤规则总配置（A 数字 + B 阶段 + C 规则链）
 * 存 system_settings.reminder_rules_config（JSON）
 */
import { getSetting, upsertSetting } from '../routes/settings.js'

export const ALL_MEMBER_STAGES = [
  '未新训', '新训初期', '新训一期', '新训二期', '新训三期', '新训准考',
  '紫夜', '紫夜尖兵', '紫夜助教',
  '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师',
]

const SETTING_KEY = 'reminder_rules_config'

/** 与当前硬编码行为一致的默认配置 */
export function getDefaultReminderRulesConfig() {
  const phase3Plus = [
    '新训三期', '新训准考', '紫夜', '紫夜尖兵', '紫夜助教',
    '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师',
  ]
  const examPlus = [
    '新训准考', '紫夜', '紫夜尖兵', '紫夜助教',
    '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师',
  ]
  return {
    version: 1,
    training: {
      /** 新训训练催促阶段 */
      stages: ['未新训', '新训初期', '新训一期', '新训二期', '新训三期', '新训准考'],
      /** 还剩 ≤N 天进入管理端训练催促名单 */
      warnDays: 3,
      /** 全局未训超时天数 */
      defaultTimeoutDays: 7,
      /** 正式队员短周期考勤（0=关闭，改走下方 idle 规则） */
      formalTimeoutDays: 0,
      /** 适用正式队员短周期 / 常驻倒计时的阶段 */
      formalStages: ['紫夜', '紫夜尖兵'],
    },
    attendance: {
      /** 考勤名单预警：还剩 ≤N 天进入管理端名单 */
      warnDays: 7,
      /**
       * 规则链（按数组顺序计算，取剩余天数最少的一条作为主因）
       * type:
       *  - until_stage: 从锚点起算，在 deadlineDays 内达到 doneWhenStages
       *  - training_idle: 对 activeWhenStages，自上次训练起 idleDays 内需再训
       */
      rules: [
        {
          id: 'to_phase3',
          enabled: true,
          type: 'until_stage',
          reasonCode: 'to_phase3',
          title: '升到三期',
          /** 名单短标签（可与规则名称不同） */
          badge: '达三期',
          badgeColor: 'yellow',
          label: '',
          startAnchor: 'join_date',
          deadlineDays: 60,
          capFromJoinDays: null,
          doneWhenStages: phase3Plus,
          /** 进入这些阶段时写入 phase3_reached_at（仅首次） */
          milestoneStages: ['新训三期', '新训准考', '紫夜', '紫夜尖兵', '紫夜助教',
            '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师'],
        },
        {
          id: 'to_exam',
          enabled: true,
          type: 'until_stage',
          reasonCode: 'to_exam',
          title: '升到准考',
          badge: '准考',
          badgeColor: 'orange',
          label: '',
          startAnchor: 'phase3_reached_at',
          deadlineDays: 45,
          capFromJoinDays: 105,
          doneWhenStages: examPlus,
          milestoneStages: [],
        },
        {
          id: 'formal_idle',
          enabled: true,
          type: 'training_idle',
          reasonCode: 'formal_idle',
          title: '正式队员再训',
          badge: '半年新训',
          badgeColor: 'purple',
          label: '',
          deadlineDays: 180,
          activeWhenStages: ['紫夜', '紫夜尖兵'],
          /** 开启正式队员短周期考勤时，默认不跑本条（单人取消考勤除外） */
          skipWhenFormalShortCycle: true,
        },
      ],
    },
  }
}

function clampInt(n, min, max, fallback) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

function sanitizeStages(list, fallback = []) {
  if (!Array.isArray(list)) return [...fallback]
  const allowed = new Set(ALL_MEMBER_STAGES)
  const out = []
  for (const s of list) {
    const t = String(s || '').trim()
    if (t && allowed.has(t) && !out.includes(t)) out.push(t)
  }
  return out.length ? out : [...fallback]
}

/** 根据规则字段生成给人看的中文说明（不暴露占位符） */
export function buildAutoRuleLabel(rule, { deadline, cap } = {}) {
  const days = deadline ?? rule.deadlineDays ?? ''
  const capDays = cap ?? rule.capFromJoinDays

  if (rule.type === 'training_idle') {
    const stages = rule.activeWhenStages || []
    const shown = stages.slice(0, 3).join('、')
    const more = stages.length > 3 ? '等' : ''
    const who = shown ? `${shown}${more}` : '指定阶段'
    return `${who}：${days} 天内需至少参加一次新训`
  }

  const start =
    rule.startAnchor === 'phase3_reached_at'
      ? '达到里程碑后'
      : rule.startAnchor === 'last_training_date'
        ? '自上次训练起'
        : '加入后'
  const targets = rule.doneWhenStages || []
  const shown = targets.slice(0, 3).join('、')
  const more = targets.length > 3 ? '等' : ''
  const goal = shown ? `${shown}${more}` : '目标阶段'
  let text = `${start} ${days} 天内需达到${goal}`
  if (capDays != null && Number(capDays) > 0) {
    text += `（自加入日起总上限 ${capDays} 天）`
  }
  return text
}

export const BADGE_COLORS = ['yellow', 'orange', 'purple', 'sky', 'green', 'rose', 'amber', 'slate']

function sanitizeBadgeColor(raw, fallback) {
  const v = String(raw || '').trim().toLowerCase()
  if (BADGE_COLORS.includes(v)) return v
  return fallback
}

function sanitizeRule(raw, index) {
  const def = getDefaultReminderRulesConfig().attendance.rules[0]
  const type = raw?.type === 'training_idle' ? 'training_idle' : 'until_stage'
  const id = String(raw?.id || `rule_${index + 1}`).slice(0, 64)
  const reasonCode = String(raw?.reasonCode || id).slice(0, 32)
  const title = String(raw?.title || '').trim().slice(0, 40)
  const badge = String(raw?.badge || '').trim().slice(0, 16)
  const defaultColor =
    reasonCode === 'to_phase3' ? 'yellow'
      : (reasonCode === 'to_exam' || reasonCode === 'to_formal') ? 'orange'
        : reasonCode === 'formal_idle' ? 'purple'
          : type === 'training_idle' ? 'purple' : 'sky'
  const base = {
    id,
    enabled: raw?.enabled !== false,
    type,
    reasonCode,
    title: title || undefined,
    badge: badge || undefined,
    badgeColor: sanitizeBadgeColor(raw?.badgeColor, defaultColor),
    label: String(raw?.label ?? '').slice(0, 200),
    deadlineDays: clampInt(raw?.deadlineDays, 1, 3650, 30),
  }
  if (type === 'training_idle') {
    const rule = {
      ...base,
      activeWhenStages: sanitizeStages(raw?.activeWhenStages, ['紫夜', '紫夜尖兵']),
      skipWhenFormalShortCycle: raw?.skipWhenFormalShortCycle !== false,
    }
    if (!rule.label || /\{(deadline|cap|days)\}/.test(rule.label)) {
      rule.label = buildAutoRuleLabel(rule)
    }
    return rule
  }
  const startAnchor = ['join_date', 'phase3_reached_at', 'last_training_date'].includes(raw?.startAnchor)
    ? raw.startAnchor
    : 'join_date'
  const rule = {
    ...base,
    startAnchor,
    capFromJoinDays: raw?.capFromJoinDays == null || raw?.capFromJoinDays === ''
      ? null
      : clampInt(raw.capFromJoinDays, 1, 3650, null),
    doneWhenStages: sanitizeStages(raw?.doneWhenStages, def.doneWhenStages),
    milestoneStages: sanitizeStages(raw?.milestoneStages, []),
  }
  if (!rule.label || /\{(deadline|cap|days)\}/.test(rule.label)) {
    rule.label = buildAutoRuleLabel(rule)
  }
  return rule
}

export function sanitizeReminderRulesConfig(input, legacy = {}) {
  const d = getDefaultReminderRulesConfig()
  const src = input && typeof input === 'object' ? input : {}
  const trainingIn = src.training && typeof src.training === 'object' ? src.training : {}
  const attendanceIn = src.attendance && typeof src.attendance === 'object' ? src.attendance : {}

  const defaultTimeoutDays = clampInt(
    trainingIn.defaultTimeoutDays ?? legacy.defaultTimeoutDays,
    1, 365, d.training.defaultTimeoutDays
  )
  const formalTimeoutDays = clampInt(
    trainingIn.formalTimeoutDays ?? legacy.formalTimeoutDays,
    0, 365, d.training.formalTimeoutDays
  )

  const rulesRaw = Array.isArray(attendanceIn.rules) ? attendanceIn.rules : d.attendance.rules
  const rules = rulesRaw.slice(0, 30).map((r, i) => sanitizeRule(r, i))

  return {
    version: 1,
    training: {
      stages: sanitizeStages(trainingIn.stages, d.training.stages),
      warnDays: clampInt(trainingIn.warnDays, 0, 30, d.training.warnDays),
      defaultTimeoutDays,
      formalTimeoutDays,
      formalStages: sanitizeStages(trainingIn.formalStages, d.training.formalStages),
    },
    attendance: {
      warnDays: clampInt(attendanceIn.warnDays, 0, 60, d.attendance.warnDays),
      rules,
    },
  }
}

export function formatRuleLabel(rule, opts = {}) {
  const template = String(rule.label || '')
  const looksLikeTemplate = !template || /\{(deadline|cap|days)\}/.test(template)
  if (looksLikeTemplate) {
    return buildAutoRuleLabel(rule, opts)
  }
  return template
    .replace(/\{deadline\}/g, String(opts.deadline ?? rule.deadlineDays ?? ''))
    .replace(/\{cap\}/g, String(opts.cap ?? rule.capFromJoinDays ?? ''))
    .replace(/\{days\}/g, String(opts.deadline ?? rule.deadlineDays ?? ''))
}

/** 设置里的规则名称 */
const FALLBACK_RULE_TITLES = {
  to_phase3: '升到三期',
  to_exam: '升到准考',
  to_formal: '升到准考',
  formal_idle: '正式队员再训',
}

/** 名单短标签（与规则名称分开） */
const FALLBACK_RULE_BADGES = {
  to_phase3: '达三期',
  to_exam: '准考',
  to_formal: '准考',
  formal_idle: '半年新训',
}

const FALLBACK_RULE_BADGE_COLORS = {
  to_phase3: 'yellow',
  to_exam: 'orange',
  to_formal: 'orange',
  formal_idle: 'purple',
}

export function resolveRuleTitle(rule) {
  const custom = String(rule?.title || '').trim()
  if (custom) return custom.slice(0, 40)
  const code = String(rule?.reasonCode || rule?.id || '')
  if (FALLBACK_RULE_TITLES[code]) return FALLBACK_RULE_TITLES[code]
  if (rule?.type === 'training_idle') return '闲置再训'
  return '考勤规则'
}

/** 名单彩色标签文案：badge → title → 默认短名 */
export function resolveRuleBadge(rule) {
  const badge = String(rule?.badge || '').trim()
  if (badge) return badge.slice(0, 16)
  const code = String(rule?.reasonCode || rule?.id || '')
  if (FALLBACK_RULE_BADGES[code]) return FALLBACK_RULE_BADGES[code]
  const title = String(rule?.title || '').trim()
  if (title) return title.slice(0, 16)
  if (rule?.type === 'training_idle') return '闲置再训'
  return '考勤'
}

export function resolveRuleBadgeColor(rule) {
  const custom = String(rule?.badgeColor || '').trim().toLowerCase()
  if (BADGE_COLORS.includes(custom)) return custom
  const code = String(rule?.reasonCode || rule?.id || '')
  if (FALLBACK_RULE_BADGE_COLORS[code]) return FALLBACK_RULE_BADGE_COLORS[code]
  return rule?.type === 'training_idle' ? 'purple' : 'sky'
}

let configCache = { at: 0, value: null }
const CONFIG_TTL_MS = 15_000

export function invalidateReminderRulesConfigCache() {
  configCache = { at: 0, value: null }
}

export async function loadReminderRulesConfig() {
  if (configCache.value && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.value
  }

  const legacyTimeout = await getSetting('reminder_timeout_days', '7')
  const legacyFormal = await getSetting('reminder_formal_timeout_days', '0')
  const legacy = {
    defaultTimeoutDays: parseInt(legacyTimeout?.setting_value, 10) || 7,
    formalTimeoutDays: Math.max(0, parseInt(legacyFormal?.setting_value, 10) || 0),
  }

  const row = await getSetting(SETTING_KEY, null)
  let parsed = null
  if (row?.setting_value) {
    try {
      parsed = JSON.parse(row.setting_value)
    } catch {
      parsed = null
    }
  }

  const config = sanitizeReminderRulesConfig(parsed || getDefaultReminderRulesConfig(), legacy)

  // 若库中尚无总配置，用默认+旧键写入一份，便于后台直接改
  if (!parsed) {
    try {
      await upsertSetting(SETTING_KEY, JSON.stringify(config), '催促/考勤规则总配置 JSON')
    } catch (e) {
      console.error('[reminderRules] seed config failed', e.message)
    }
  }

  configCache = { at: Date.now(), value: config }
  return config
}

export async function saveReminderRulesConfig(input) {
  const legacyTimeout = await getSetting('reminder_timeout_days', '7')
  const legacyFormal = await getSetting('reminder_formal_timeout_days', '0')
  const config = sanitizeReminderRulesConfig(input, {
    defaultTimeoutDays: parseInt(legacyTimeout?.setting_value, 10) || 7,
    formalTimeoutDays: Math.max(0, parseInt(legacyFormal?.setting_value, 10) || 0),
  })
  await upsertSetting(SETTING_KEY, JSON.stringify(config), '催促/考勤规则总配置 JSON')
  // 同步旧键，兼容尚未改完的读取路径
  await upsertSetting('reminder_timeout_days', String(config.training.defaultTimeoutDays), '催促名单全局超时天数设置')
  await upsertSetting(
    'reminder_formal_timeout_days',
    String(config.training.formalTimeoutDays),
    '正式队员（紫夜/尖兵）训练催促天数，0=关闭改走180天考勤'
  )
  invalidateReminderRulesConfigCache()
  return config
}
