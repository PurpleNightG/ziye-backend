/**
 * 管理端智能助手（智谱 GLM，工具调用可操作/查询管理系统）
 * 环境变量：
 *   ZHIPU_API_KEY   必填才可用
 *   ZHIPU_MODEL            默认 glm-4.5-flash（优先）
 *   ZHIPU_FALLBACK_MODEL   过载降级链，逗号分隔，默认 glm-4.7-flash,glm-4-flash
 */
import express from 'express'
import { pool } from '../config/database.js'
import { requireAdmin } from '../utils/authGate.js'
import { toMySQLDate, parseShanghaiDateTime } from '../utils/date.js'
import {
  buildActivitySummary,
  shanghaiToday,
  getOrCreateTodayDay,
  regenerateCode,
  stopDay,
  countRecords,
  listRecords,
  syncProxyCheckinFromTrainingDate,
  ensureCheckinTables,
} from '../utils/checkinService.js'
import { loadReminderConfig, queryTrainingReminders } from '../utils/trainingReminderList.js'
import {
  loadReminderRulesConfig,
  saveReminderRulesConfig,
  buildAutoRuleLabel,
  resolveRuleTitle,
} from '../utils/reminderRulesConfig.js'
import {
  loadAttendanceContext,
  buildAttendanceList,
  ensureAttendanceOverrideTable,
} from './reminders.js'
import { computeAttendanceForMember } from '../utils/attendanceReminder.js'
import { getSetting, upsertSetting } from './settings.js'
import {
  expandSurveyFields,
  buildSatisfactionSummary,
  buildSurveyAiSummary,
} from '../utils/surveyHelpers.js'

const router = express.Router()

const ACTIVITY_REPORT_KEY = 'admin_ai_activity_report'

function surveyReportSettingKey(surveyId) {
  return `admin_ai_survey_report_${Number(surveyId)}`
}

async function readStoredActivityReport() {
  const row = await getSetting(ACTIVITY_REPORT_KEY, null)
  if (!row?.setting_value) return null
  try {
    const parsed = JSON.parse(row.setting_value)
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.narrative) return null
    return parsed
  } catch {
    return null
  }
}

async function writeStoredActivityReport(payload) {
  await upsertSetting(
    ACTIVITY_REPORT_KEY,
    JSON.stringify(payload),
    '管理端 AI 活跃度总结（单条覆盖保存）'
  )
}

async function readStoredSurveyReport(surveyId) {
  const row = await getSetting(surveyReportSettingKey(surveyId), null)
  if (!row?.setting_value) return null
  try {
    const parsed = JSON.parse(row.setting_value)
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.narrative) return null
    return parsed
  } catch {
    return null
  }
}

async function writeStoredSurveyReport(surveyId, payload) {
  await upsertSetting(
    surveyReportSettingKey(surveyId),
    JSON.stringify(payload),
    `管理端 AI 问卷结果总结 #${surveyId}（无手动刷新）`
  )
}

/** 签到数据指纹：有人签到 / 代签线索变化时与缓存比对，自动重生成 */
function activityFingerprint(summary) {
  if (!summary) return ''
  return [
    summary.today,
    summary.window_days,
    summary.checkin_total,
    summary.checkin_unique_members,
    summary.checkin_days_with_records,
    summary.checkin_self,
    summary.checkin_proxy,
    summary.today_checkin?.checked_count ?? -1,
    summary.today_checkin?.status ?? '',
    summary.ip_change_suspect_count ?? 0,
    (summary.ip_change_suspect_names || []).join(','),
    (summary.proxy_member_names || []).join(','),
  ].join('|')
}

function surveyReportFingerprint(facts) {
  if (!facts) return ''
  return [
    facts.survey_id,
    facts.status,
    facts.response_count,
    facts.claim_count ?? '',
    facts.text_answer_count ?? 0,
    facts.is_satisfaction ? 1 : 0,
  ].join('|')
}

/** 单张问卷结果页用的分析事实 */
async function buildSingleSurveyReportFacts(surveyId) {
  const id = Number(surveyId)
  const [[row]] = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS response_count,
            (SELECT COUNT(*) FROM survey_claims c WHERE c.survey_id = s.id) AS claim_count,
            (SELECT COUNT(*) FROM survey_claims c WHERE c.survey_id = s.id AND c.submitted_at IS NOT NULL) AS submitted_claims
     FROM surveys s
     WHERE s.id = ?`,
    [id]
  )
  if (!row) return null

  let templates = []
  let subjects = []
  try {
    templates =
      typeof row.fields_json === 'string'
        ? JSON.parse(row.fields_json || '[]')
        : row.fields_json || []
    subjects =
      typeof row.subjects_json === 'string'
        ? JSON.parse(row.subjects_json || '[]')
        : row.subjects_json || []
  } catch {
    templates = []
    subjects = []
  }
  const fields =
    Array.isArray(subjects) && subjects.length
      ? expandSurveyFields(subjects, templates)
      : Array.isArray(templates)
        ? templates
        : []

  const [respRows] = await pool.query(
    `SELECT answers_json FROM survey_responses WHERE survey_id = ? ORDER BY id DESC LIMIT 500`,
    [id]
  )
  const answersList = (respRows || []).map((r) => {
    try {
      return typeof r.answers_json === 'string'
        ? JSON.parse(r.answers_json)
        : r.answers_json || {}
    } catch {
      return {}
    }
  })

  let satisfaction = null
  if (Array.isArray(subjects) && subjects.length) {
    try {
      satisfaction = buildSatisfactionSummary(
        subjects,
        fields,
        answersList.map((answers) => ({ answers }))
      )
    } catch {
      satisfaction = null
    }
  }

  const responseCount = Number(row.response_count || 0)
  const maxResp =
    row.max_responses != null && Number(row.max_responses) > 0
      ? Number(row.max_responses)
      : null
  const fillRateHint =
    maxResp != null ? `${responseCount}/${maxResp}` : `${responseCount} 份（未设上限）`

  const built = buildSurveyAiSummary({
    title: row.title,
    windowStatus: row.status === 'closed' ? '已关闭' : row.status === 'draft' ? '草稿' : '进行中',
    windowMessage: null,
    status: row.status,
    isAnonymous: !!row.is_anonymous,
    fillRateHint,
    claimCount: row.is_anonymous ? Number(row.claim_count || 0) : null,
    submittedClaims: row.is_anonymous ? Number(row.submitted_claims || 0) : null,
    respondents: [],
    subjects,
    fields,
    answersList,
    satisfaction,
  })

  return {
    survey_id: id,
    title: row.title,
    status: row.status,
    is_anonymous: !!row.is_anonymous,
    is_satisfaction: Array.isArray(subjects) && subjects.length > 0,
    response_count: responseCount,
    claim_count: row.is_anonymous ? Number(row.claim_count || 0) : null,
    text_answer_count: built.text_answer_count,
    analysis_payload: built.analysis_payload,
    briefing: built.summary_text,
  }
}

/** 今天 → 目标日整天差（目标日为今天则为 0） */
function daysFromTodayToYmd(ymd) {
  const today = shanghaiToday()
  const a = new Date(`${today}T12:00:00`).getTime()
  const b = new Date(`${ymd}T12:00:00`).getTime()
  return Math.round((b - a) / 86400000)
}

/** 按阶段/昵称筛选催促名单项 */
function filterByStageNick(list, a, nameKey = 'member_name') {
  const excludeStages = new Set((a.exclude_stages || []).map(String))
  const excludeNicks = new Set((a.exclude_nicknames || []).map(String))
  const onlyStages = (a.only_stages || []).map(String)
  const includeNicks = (a.include_nicknames || []).map(String)
  return (list || []).filter((m) => {
    const stage = String(m.stage_role || '')
    const nick = String(m[nameKey] || m.nickname || m.member_name || '')
    if (excludeStages.size && excludeStages.has(stage)) return false
    if (excludeNicks.size && excludeNicks.has(nick)) return false
    if (onlyStages.length && !onlyStages.includes(stage)) return false
    if (includeNicks.length && !includeNicks.includes(nick)) return false
    return true
  })
}

async function upsertTrainingCustomTimeout(memberId, timeoutValue) {
  const [existing] = await pool.query('SELECT id FROM reminder_list WHERE member_id = ?', [memberId])
  if (timeoutValue == null) {
    await pool.query('DELETE FROM reminder_list WHERE member_id = ?', [memberId])
    return
  }
  if (existing.length > 0) {
    await pool.query('UPDATE reminder_list SET custom_timeout_days = ? WHERE member_id = ?', [
      timeoutValue,
      memberId,
    ])
  } else {
    await pool.query(
      `INSERT INTO reminder_list (member_id, member_name, stage_role, last_training_date, days_without_training, custom_timeout_days)
       SELECT m.id, m.nickname, m.stage_role, m.last_training_date,
         CASE WHEN m.last_training_date IS NOT NULL
           THEN DATEDIFF(CURDATE(), m.last_training_date)
           ELSE DATEDIFF(CURDATE(), m.join_date)
         END,
         ?
       FROM members m WHERE m.id = ?`,
      [timeoutValue, memberId]
    )
  }
}

const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'

/** 调用链：优先 4.5 → 4.7 → 4-flash（过载时依次降级） */
function modelChain() {
  const primary = String(process.env.ZHIPU_MODEL || 'glm-4.5-flash').trim()
  const fbRaw = String(
    process.env.ZHIPU_FALLBACK_MODEL || 'glm-4.7-flash,glm-4-flash'
  )
  const fallbacks = fbRaw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const list = [primary, ...fallbacks]
  return list.filter((m, i, a) => m && a.indexOf(m) === i)
}

function modelName() {
  return modelChain()[0] || 'glm-4.5-flash'
}

function fallbackModelName() {
  const chain = modelChain()
  return chain.slice(1).join(',') || 'glm-4.7-flash,glm-4-flash'
}

function apiKey() {
  return String(process.env.ZHIPU_API_KEY || '').trim()
}

/** 某模型过载后短暂跳过，避免连续打爆 */
const modelCooldownUntil = new Map()
let lastUsedModel = modelName()

function isCapacityOrRateLimitError(res, data) {
  const code = Number(data?.error?.code ?? data?.code ?? 0)
  if (res.status === 429) return true
  if ([1302, 1305, 1308].includes(code)) return true
  const msg = String(data?.error?.message || data?.msg || data?.message || '')
  return /访问量过大|速率限制|稍后再试|rate.?limit|too many requests|overloaded|concurrency/i.test(msg)
}

async function callZhipuOnce(messages, tools, model) {
  const key = apiKey()
  if (!key) {
    const err = new Error('未配置 ZHIPU_API_KEY')
    err.code = 'NO_KEY'
    throw err
  }
  const body = {
    model,
    messages,
    temperature: 0.2,
  }
  if (tools) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const res = await fetch(ZHIPU_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.error?.message || data?.msg || `智谱接口错误 HTTP ${res.status}`
    const err = new Error(msg)
    err.code = 'ZHIPU_HTTP'
    err.httpStatus = res.status
    err.zhipuCode = data?.error?.code ?? data?.code
    err.capacity = isCapacityOrRateLimitError(res, data)
    err.raw = data
    throw err
  }
  return data
}

function orderedModelsForAttempt() {
  const chain = modelChain()
  const now = Date.now()
  const ready = []
  const cooling = []
  for (const m of chain) {
    if ((modelCooldownUntil.get(m) || 0) > now) cooling.push(m)
    else ready.push(m)
  }
  // 冷却中的放最后，仍作最后兜底
  return [...ready, ...cooling]
}

/**
 * 优先 4.5-flash；访问量过大/限流时依次降级 4.7-flash → 4-flash
 */
async function callZhipu(messages, tools) {
  const tryOrder = orderedModelsForAttempt()
  let lastErr = null
  for (let i = 0; i < tryOrder.length; i++) {
    const model = tryOrder[i]
    try {
      const data = await callZhipuOnce(messages, tools, model)
      lastUsedModel = model
      modelCooldownUntil.delete(model)
      return data
    } catch (e) {
      lastErr = e
      const next = tryOrder[i + 1]
      const canFallback = e.capacity && next
      if (canFallback) {
        modelCooldownUntil.set(model, Date.now() + 3 * 60 * 1000)
        console.warn(`[adminAi] ${model} 过载/限流，降级尝试 ${next}: ${e.message}`)
        continue
      }
      throw e
    }
  }
  throw lastErr || new Error('智谱调用失败')
}

function activeModelName() {
  return lastUsedModel || modelName()
}

function getPrimaryCooldownMs() {
  const primary = modelName()
  return Math.max(0, (modelCooldownUntil.get(primary) || 0) - Date.now())
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'summarize_activity',
      description: '汇总签到活跃度：窗口内签到人次/到场人数/按日曲线/今日签到等（不以请假或在册状态当活跃度）',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '统计窗口天数，默认14' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_on_leave',
      description: '统计当前正在请假中的学员数量与名单（看成员状态=请假中，或请假记录状态=请假中）',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'boolean', description: '是否返回名单，默认 true' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rank_leave_days',
      description:
        '按请假天数排名。用于回答「谁请假天数最多」「请假总天数排行」等。' +
        'scope=active：只统计当前进行中的请假（按本次 total_days）；' +
        'scope=all：统计历史累计请假天数（leave_records 之和）。默认 all。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['all', 'active'],
            description: 'all=历史累计，active=当前请假中',
          },
          limit: { type: 'number', description: '返回前 N 名，默认 15' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_today_checkin',
      description: '获取今日签到任务状态、签到码与已签到人数/名单',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'regenerate_checkin_code',
      description: '更换今日签到码 / 重新开训（管理操作）',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_today_checkin',
      description: '停止今日签到，表示今日未开训',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_members',
      description: '按昵称或QQ搜索成员，返回 id/状态/最后新训日期。写操作前应先搜索确认唯一成员。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '关键词' },
          limit: { type: 'number' },
        },
        required: ['q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_last_training_date',
      description: '设置一名或多名成员的最后新训日期（管理代签考勤）。日期默认今天。',
      parameters: {
        type: 'object',
        properties: {
          member_ids: {
            type: 'array',
            items: { type: 'number' },
            description: '成员ID列表',
          },
          nicknames: {
            type: 'array',
            items: { type: 'string' },
            description: '按昵称匹配（当未给ID时）',
          },
          date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_stale_members',
      description:
        '列出超过 N 天未新训的成员。用户若要求「不包括请假/留队」，必须把对应 exclude 参数设为 true 并重新调用本工具，禁止复用旧名单。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '默认7' },
          limit: { type: 'number', description: '默认30' },
          exclude_on_leave: {
            type: 'boolean',
            description: '排除 status=请假中 的成员，默认 true',
          },
          exclude_retention: {
            type: 'boolean',
            description: '排除留队名单（retention_records）中的成员，默认 true',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_black_point',
      description:
        '给成员登记黑点（真实写入数据库）。必须先 search_members 确认成员，再调用。成功返回 black_point_id。',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number', description: '成员ID（优先）' },
          nickname: { type: 'string', description: '昵称（无ID时）' },
          reason: { type: 'string', description: '黑点原因，必填' },
          register_date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_leave',
      description:
        '为成员登记请假（真实写入数据库）。相对日期必须用 until_offset_days，禁止自己编造年份：' +
        '今天结束=0，明天=1，后天=2，大后天=3。也可传绝对 end_date(YYYY-MM-DD)但年份必须与今天相同。',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          reason: { type: 'string', description: '请假原因' },
          start_date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
          until_offset_days: {
            type: 'number',
            description: '相对开始日的结束偏移：今天0、明天1、后天2。用户说「到后天」时传 2',
          },
          end_date: {
            type: 'string',
            description: '可选绝对结束日 YYYY-MM-DD；有 until_offset_days 时忽略本字段',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_member',
      description: '获取单个成员详情（状态、阶段、最后新训、是否助教等），写操作前建议先调用',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_member',
      description:
        '更新成员状态(status)或阶段(stage_role)或备注。status 常用：正常/请假中/已退队。' +
        '阶段如：未新训、新训一期、新训二期、新训三期、新训准考、紫夜、紫夜尖兵、紫夜助教等。必须先确认 member_id。',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          status: { type: 'string' },
          stage_role: { type: 'string' },
          remarks: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_leaves',
      description: '列出请假记录。可按成员筛选；active_only=true 只看进行中（请假中/待结束审批）',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          active_only: { type: 'boolean', description: '默认 true' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_leave',
      description: '修改请假记录的原因/起止日期（需 leave_id）。会重算 total_days。',
      parameters: {
        type: 'object',
        properties: {
          leave_id: { type: 'number' },
          reason: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
        },
        required: ['leave_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_leave',
      description:
        '删除请假记录（不是结束请假）。可传 leave_id，或 member_id/nickname 删除其最近一条请假（含已结束）。' +
        '用户说「删除请假记录」必须用本工具，禁止用 end_leave。',
      parameters: {
        type: 'object',
        properties: {
          leave_id: { type: 'number' },
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          only_active: {
            type: 'boolean',
            description: 'true=只删进行中；默认 false 可删最近一条任意状态',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_leave',
      description:
        '提前或正常结束成员请假（销假）。禁止用 update_member；删除记录请用 delete_leave。' +
        '会把请假改为已结束、结束日改为今天（提前结束）、成员改回正常。',
      parameters: {
        type: 'object',
        properties: {
          leave_id: { type: 'number' },
          member_id: { type: 'number' },
          nickname: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_black_points',
      description: '查询黑点记录。可按成员筛选；active_only 默认只看生效中',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          active_only: { type: 'boolean', description: '默认 true' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invalidate_black_point',
      description:
        '撤销黑点：把一条生效中的记录改为「已失效」（不删库）。用户说「撤销/失效」时用本工具。' +
        '用户说「删除」请用 delete_black_points。',
      parameters: {
        type: 'object',
        properties: {
          black_point_id: { type: 'number' },
        },
        required: ['black_point_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_black_points',
      description:
        '从数据库真正删除黑点记录（DELETE，不是改成已失效）。用户说「删除黑点」必须用本工具。' +
        '可传 black_point_id 删一条；或传 member_id / nickname 删除该成员的黑点（默认全部；active_only=true 只删生效中）。',
      parameters: {
        type: 'object',
        properties: {
          black_point_id: { type: 'number' },
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          active_only: {
            type: 'boolean',
            description: '仅删除生效中的黑点；默认 false（该成员全部删除）',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_retention',
      description: '列出留队成员名单',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_quit_pending',
      description: '统计/列出待审批退队申请',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'boolean', description: '默认 true' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_training_reminders',
      description: '获取训练催促名单（与催促名单页面同源规则），含剩余天数等',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '默认40' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_progress_reminders',
      description:
        '列出「进度催促」名单（原考勤催促：升期/闲置进度规则链，不是训练催促）。',
      parameters: {
        type: 'object',
        properties: {
          show_all: { type: 'boolean', description: '是否含未进预警窗的，默认 false' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_set_training_quit_date',
      description:
        '批量设置「训练催促」成员的希望退队日期（写入 custom_timeout_days）。' +
        '可 exclude_stages（如 ["紫夜","紫夜尖兵"]）或 exclude_nicknames。' +
        '传 quit_date(YYYY-MM-DD) 或 remaining_days（还剩几天）。' +
        '仅处理当前训练催促名单中的成员。',
      parameters: {
        type: 'object',
        properties: {
          quit_date: { type: 'string' },
          remaining_days: { type: 'number' },
          exclude_stages: { type: 'array', items: { type: 'string' } },
          exclude_nicknames: { type: 'array', items: { type: 'string' } },
          only_stages: { type: 'array', items: { type: 'string' } },
          include_nicknames: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_set_progress_quit_date',
      description:
        '批量设置「进度催促」成员的希望退队：按 remaining_days 或 quit_date。' +
        '可 exclude_stages / exclude_nicknames / only_stages。',
      parameters: {
        type: 'object',
        properties: {
          quit_date: { type: 'string' },
          remaining_days: { type: 'number' },
          exclude_stages: { type: 'array', items: { type: 'string' } },
          exclude_nicknames: { type: 'array', items: { type: 'string' } },
          only_stages: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reminder_rules',
      description:
        '获取催促规则总配置。进度催促规则链在 progress_rules（升到三期/升到准考/正式队员再训等），' +
        '改某条天数前先调本工具确认 id / title。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_reminder_rules',
      description:
        '修改催促规则并写库。两类改法：' +
        'A) 全局数字：default_timeout_days / formal_timeout_days / training_warn_days / progress_warn_days；' +
        'B) 进度催促规则链单条：传 rule_query（如「升到三期」「to_phase3」「准考」「半年新训」）+ rule_deadline_days。' +
        '用户说「升到三期改成40天」必须用 B，不要只改预警天数。改前可先 get_reminder_rules。',
      parameters: {
        type: 'object',
        properties: {
          default_timeout_days: { type: 'number' },
          formal_timeout_days: { type: 'number', description: '正式队员全局短周期天数，0关闭' },
          training_warn_days: { type: 'number' },
          progress_warn_days: { type: 'number', description: '进度催促预警天数（进名单阈值，不是升期时限）' },
          rule_query: {
            type: 'string',
            description:
              '要改的进度规则：id/reasonCode/标题/短标签均可。例：升到三期、to_phase3、达三期、升到准考、to_exam、正式队员再训、formal_idle、半年新训',
          },
          rule_deadline_days: {
            type: 'number',
            description: '该规则时限天数（until_stage=须在 N 天内达标；training_idle=闲置 N 天须再训）',
          },
          rule_enabled: { type: 'boolean', description: '是否启用该规则' },
          rule_cap_from_join_days: {
            type: 'number',
            description: '自加入日起总上限天数；传 0 或负数表示清除上限（仅 until_stage）',
          },
          rule_title: { type: 'string', description: '可选，重命名规则标题' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_quit_approvals',
      description: '列出退队审批（不含已批准归档）。可按 status 筛选：待审批/已拒绝。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '待审批 或 已拒绝；不传则两者都返回' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_quit_approval',
      description: '为成员创建退队审批（待审批）。需 member_id 或唯一 nickname，以及 remarks 退队原因。',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          remarks: { type: 'string', description: '退队原因，必填' },
        },
        required: ['remarks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_quit_approvals',
      description:
        '批量批准或拒绝退队审批。action=approve 将成员改为已退队；action=reject 将成员恢复为正常。' +
        '传 quit_ids，或 nicknames/member_ids（匹配待审批记录）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['approve', 'reject'] },
          quit_ids: { type: 'array', items: { type: 'number' } },
          member_ids: { type: 'array', items: { type: 'number' } },
          nicknames: { type: 'array', items: { type: 'string' } },
          remarks: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_quit_approvals',
      description: '删除退队审批记录。删除待审批时会把成员状态恢复为正常。',
      parameters: {
        type: 'object',
        properties: {
          quit_ids: { type: 'array', items: { type: 'number' } },
          member_ids: { type: 'array', items: { type: 'number' } },
          nicknames: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_retention',
      description: '为成员添加留队记录，并从催促名单移除。需留队原因 retention_reason。',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          retention_reason: { type: 'string' },
          approver_remarks: { type: 'string' },
        },
        required: ['retention_reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_retention',
      description: '删除留队记录。传 retention_ids，或按 nickname/member_id 匹配。',
      parameters: {
        type: 'object',
        properties: {
          retention_ids: { type: 'array', items: { type: 'number' } },
          member_ids: { type: 'array', items: { type: 'number' } },
          nicknames: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_update_members',
      description:
        '批量改成员状态/阶段/最后新训日期。传 member_ids 或 nicknames，以及要改的字段。' +
        '请假中成员不能用本工具改状态（须 end_leave）。不支持重置密码。',
      parameters: {
        type: 'object',
        properties: {
          member_ids: { type: 'array', items: { type: 'number' } },
          nicknames: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', description: '如 正常/已退队' },
          stage_role: { type: 'string' },
          last_training_date: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_assessment_applications',
      description: '列出考核审批申请（非反作弊）。可按 status：待审批/已通过/已驳回。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_assessment_applications',
      description:
        '批准或驳回考核申请。action=approve 生成准考证；action=reject 必须提供 reject_reason。' +
        '传 application_ids，或 nicknames 匹配待审批。不含反作弊功能。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['approve', 'reject'] },
          application_ids: { type: 'array', items: { type: 'number' } },
          nicknames: { type: 'array', items: { type: 'string' } },
          reject_reason: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_assessment_applications',
      description: '删除考核申请记录（按 application_ids）。',
      parameters: {
        type: 'object',
        properties: {
          application_ids: { type: 'array', items: { type: 'number' }, description: '申请 id 列表' },
        },
        required: ['application_ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_assessments',
      description: '列出考核记录（成绩/报告类，非反作弊）。可按成员筛选。',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'number' },
          nickname: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_courses',
      description: '列出课程（id/code/名称/分类/难度）。可按关键词 q 筛选。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_set_course_progress',
      description:
        '批量为多名成员设置某门课程进度。progress 只能是 0/10/20/50/75/100（0=清除进度）。' +
        '需 course_id（可先 list_courses），以及 member_ids 或 nicknames。阶段需之后在页面「同步阶段」或另说。',
      parameters: {
        type: 'object',
        properties: {
          course_id: { type: 'number' },
          course_code: { type: 'string', description: '如 1.1，可代替 course_id' },
          member_ids: { type: 'array', items: { type: 'number' } },
          nicknames: { type: 'array', items: { type: 'string' } },
          progress: { type: 'number', description: '0/10/20/50/75/100' },
        },
        required: ['progress'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_assistant_pending',
      description: '列出助教管理待审批：带学员申请、建档、升期、编辑、黑点、请假等（仅摘要，不含反作弊）。',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: '可选过滤：assignments/creates/promotions/edits/blackPoints/leaves；不传返回各类计数+待审列表',
          },
          pending_only: { type: 'boolean', description: '默认 true，只看待审批' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_assistant_assignment',
      description: '审批助教「申请带学员」：status=已通过 或 已拒绝。传 assignment_id。',
      parameters: {
        type: 'object',
        properties: {
          assignment_id: { type: 'number' },
          status: { type: 'string', enum: ['已通过', '已拒绝'] },
          remarks: { type: 'string' },
        },
        required: ['assignment_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_surveys',
      description: '列出填表/问卷（标题、状态、是否匿名、起止时间、答卷数）。总结前可先调用以确认 survey_id。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '标题关键词，可选' },
          status: {
            type: 'string',
            description: 'draft / published / closed；不传则全部',
          },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_survey',
      description:
        '拉取一张填表/满意度问卷的统计事实（均分、选项分布、开放题原文），供你写分析性总结。' +
        '传 survey_id 或 title 关键词。不要只复述数字，要归纳主题与建议。',
      parameters: {
        type: 'object',
        properties: {
          survey_id: { type: 'number' },
          title: { type: 'string', description: '标题关键词，用于查找问卷' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_how_to',
      description:
        '解答「怎么操作/在哪设置」类问题：催促名单、退队日期、规则总设置、训练催促与进度催促区别等。不写库。',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '主题关键词，如 退队日期、规则设置、进度催促、训练催促、正式队员',
          },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_capabilities',
      description: '列出本助手当前已接入的全部可查询/可操作能力。用户问「你能干什么/接入了什么」时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
]

function adminActor(req) {
  const u = req.admin || req.user || {}
  return { id: u.id, name: u.name || u.username || '管理员' }
}

/** YYYY-MM-DD + N 天（按日历日，避免时区坑） */
function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + Number(days || 0))
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** 进度催促规则链：按口语/id/标题匹配 */
function findAttendanceRuleIndex(rules, query) {
  const raw = String(query || '').trim()
  if (!raw || !Array.isArray(rules)) return -1
  const q = raw.toLowerCase()

  const aliasToId = [
    [/^(to_)?phase3$|升到三期|达三期|^三期$/, 'to_phase3'],
    [/^(to_)?exam$|升到准考|^准考$|to_formal/, 'to_exam'],
    [/formal_idle|正式队员再训|半年新训|闲置再训/, 'formal_idle'],
  ]
  let preferId = null
  for (const [re, id] of aliasToId) {
    if (re.test(raw) || re.test(q)) {
      preferId = id
      break
    }
  }
  if (preferId) {
    const byId = rules.findIndex(
      (r) => r.id === preferId || r.reasonCode === preferId
    )
    if (byId >= 0) return byId
  }

  let idx = rules.findIndex(
    (r) =>
      String(r.id || '').toLowerCase() === q ||
      String(r.reasonCode || '').toLowerCase() === q
  )
  if (idx >= 0) return idx

  idx = rules.findIndex((r) => {
    const title = String(r.title || resolveRuleTitle(r) || '').toLowerCase()
    const badge = String(r.badge || '').toLowerCase()
    return title === q || badge === q || title.includes(q) || q.includes(title)
  })
  return idx
}

function summarizeProgressRules(config) {
  const rules = config?.attendance?.rules || []
  return rules.map((r, i) => ({
    index: i,
    id: r.id,
    reasonCode: r.reasonCode,
    title: resolveRuleTitle(r) || r.title || r.id,
    badge: r.badge || null,
    enabled: r.enabled !== false,
    type: r.type,
    deadlineDays: r.deadlineDays,
    capFromJoinDays: r.capFromJoinDays ?? null,
    startAnchor: r.startAnchor || null,
    label: r.label || buildAutoRuleLabel(r),
  }))
}

/** 从用户原话解析相对结束偏移：后天=2 */
function parseRelativeEndOffset(text) {
  const t = String(text || '')
  if (/大后天/.test(t)) return 3
  if (/后天/.test(t)) return 2
  if (/明天|明日/.test(t)) return 1
  if (/(请假到|请到|到)\s*今天|今日/.test(t)) return 0
  const m = t.match(/(?:请假|请)\s*(\d+)\s*天/)
  if (m) return Math.max(0, Number(m[1]) - 1)
  return null
}

function resolveLeaveEndDate(args, userMessage) {
  const startDate = toMySQLDate(args.start_date) || shanghaiToday()
  let offset =
    args.until_offset_days != null && args.until_offset_days !== ''
      ? Number(args.until_offset_days)
      : null
  if (offset == null || Number.isNaN(offset)) {
    offset = parseRelativeEndOffset(userMessage)
  }
  if (offset != null && !Number.isNaN(offset)) {
    return { startDate, endDate: addDaysYmd(startDate, offset), via: `offset_${offset}` }
  }

  let endDate = toMySQLDate(args.end_date)
  if (!endDate) {
    return {
      startDate,
      endDate: null,
      error: '缺少结束日期。相对日期请传 until_offset_days（明天1、后天2）',
    }
  }
  const startYear = Number(startDate.slice(0, 4))
  const endYear = Number(endDate.slice(0, 4))
  if (Math.abs(endYear - startYear) > 0 || endDate < startDate) {
    // 模型常把后天编成 2023：丢弃并尝试从原话解析
    const fallback = parseRelativeEndOffset(userMessage)
    if (fallback != null) {
      return {
        startDate,
        endDate: addDaysYmd(startDate, fallback),
        via: `sanitized_from_user_offset_${fallback}`,
        discarded_end_date: endDate,
      }
    }
    return {
      startDate,
      endDate: null,
      error: `结束日期 ${endDate} 无效（相对开始日 ${startDate}）。请传 until_offset_days：明天=1，后天=2`,
      discarded_end_date: endDate,
    }
  }
  return { startDate, endDate, via: 'absolute' }
}

async function resolveMemberIds({ member_ids, nicknames, nickname }) {
  let ids = Array.isArray(member_ids) ? member_ids.map(Number).filter(Boolean) : []
  const names = [
    ...(Array.isArray(nicknames) ? nicknames : []),
    ...(nickname ? [nickname] : []),
  ]
  if (!ids.length && names.length) {
    for (const nick of names) {
      const n = String(nick || '').trim()
      if (!n) continue
      const [hits] = await pool.query(
        `SELECT id FROM members
         WHERE status != '已退队' AND nickname LIKE ?
         LIMIT 5`,
        [`%${n}%`]
      )
      ids.push(...hits.map((h) => Number(h.id)))
    }
    ids = [...new Set(ids)]
  }
  return ids
}

function normalizeIdList(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isFinite(n) && n > 0)
  if (raw == null || raw === '') return []
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? [n] : []
}

function genAdmissionTicket(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now())
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const random = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `PNG${year}${month}${day}${random}`
}

async function resolveQuitApprovalIds(a) {
  let ids = normalizeIdList(a.quit_ids ?? a.ids)
  if (ids.length) return ids
  const memberIds = await resolveMemberIds(a)
  if (!memberIds.length) return []
  const ph = memberIds.map(() => '?').join(',')
  const [rows] = await pool.query(
    `SELECT id FROM quit_approvals
     WHERE member_id IN (${ph}) AND status = '待审批'
     ORDER BY id DESC`,
    memberIds
  )
  return rows.map((r) => Number(r.id))
}

async function runTool(name, args, req) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'summarize_activity':
      return buildActivitySummary({ days: a.days || 14 })

    case 'count_on_leave': {
      // 同时看成员状态与请假记录，避免状态未同步导致「明明有请假却查不到」
      const [rows] = await pool.query(
        `SELECT DISTINCT m.id, m.nickname, m.qq, m.stage_role, m.status,
                lr.total_days, lr.start_date, lr.end_date, lr.status AS leave_status
         FROM members m
         LEFT JOIN leave_records lr
           ON lr.member_id = m.id AND lr.status IN ('请假中', '待结束审批')
         WHERE m.status = '请假中'
            OR lr.id IS NOT NULL
         ORDER BY m.nickname ASC
         LIMIT 100`
      )
      const list = a.list === false ? [] : rows
      return {
        count: rows.length,
        list,
        note: '含成员状态为请假中，或存在进行中请假记录的成员',
      }
    }

    case 'rank_leave_days': {
      const scope = a.scope === 'active' ? 'active' : 'all'
      const limit = Math.min(50, Math.max(1, Number(a.limit) || 15))

      if (scope === 'active') {
        const [rows] = await pool.query(
          `SELECT m.id, m.nickname, m.qq, m.stage_role, m.status,
                  lr.total_days AS leave_days,
                  lr.start_date, lr.end_date, lr.reason,
                  DATEDIFF(lr.end_date, CURDATE()) AS remaining_days
           FROM leave_records lr
           INNER JOIN members m ON m.id = lr.member_id
           WHERE lr.status IN ('请假中', '待结束审批')
             AND m.status != '已退队'
           ORDER BY lr.total_days DESC, lr.end_date DESC
           LIMIT ?`,
          [limit]
        )
        return {
          scope: 'active',
          count: rows.length,
          ranking: rows,
          note: '按当前进行中请假单的 total_days 排序',
        }
      }

      const [rows] = await pool.query(
        `SELECT m.id, m.nickname, m.qq, m.stage_role, m.status,
                SUM(lr.total_days) AS leave_days,
                COUNT(*) AS leave_count,
                SUM(CASE WHEN lr.status IN ('请假中', '待结束审批') THEN 1 ELSE 0 END) AS active_leave_count
         FROM leave_records lr
         INNER JOIN members m ON m.id = lr.member_id
         WHERE m.status != '已退队'
         GROUP BY m.id, m.nickname, m.qq, m.stage_role, m.status
         ORDER BY leave_days DESC, leave_count DESC
         LIMIT ?`,
        [limit]
      )
      return {
        scope: 'all',
        count: rows.length,
        ranking: rows,
        top: rows[0] || null,
        note: '按历史 leave_records.total_days 累计排序；top 为请假天数最多者',
      }
    }

    case 'get_today_checkin': {
      await ensureCheckinTables()
      const day = await getOrCreateTodayDay(adminActor(req))
      const records = await listRecords(day.id)
      return {
        checkin_date: day.checkin_date,
        code: day.code,
        status: day.status,
        checked_count: await countRecords(day.id),
        records: records.slice(0, 80).map((r) => ({
          member_id: r.member_id,
          member_name: r.member_name,
          source: r.source,
          proxy_name: r.proxy_name,
        })),
      }
    }

    case 'regenerate_checkin_code': {
      const day = await getOrCreateTodayDay(adminActor(req))
      const updated = await regenerateCode(day.id, adminActor(req))
      return { code: updated.code, status: updated.status, checkin_date: updated.checkin_date }
    }

    case 'stop_today_checkin': {
      const day = await getOrCreateTodayDay(adminActor(req))
      const updated = await stopDay(day.id, adminActor(req))
      return { status: updated.status, checkin_date: updated.checkin_date, message: '已停止今日签到' }
    }

    case 'search_members': {
      const q = String(a.q || '').trim()
      if (!q) return { list: [] }
      const like = `%${q}%`
      const [rows] = await pool.query(
        `SELECT id, nickname, qq, stage_role, status, last_training_date
         FROM members
         WHERE status != '已退队'
           AND (nickname LIKE ? OR qq LIKE ? OR CAST(id AS CHAR) = ?)
         ORDER BY nickname ASC
         LIMIT ?`,
        [like, like, q, Math.min(50, Number(a.limit) || 20)]
      )
      return { list: rows }
    }

    case 'set_last_training_date': {
      const date = toMySQLDate(a.date) || shanghaiToday()
      const ids = await resolveMemberIds(a)
      if (!ids.length) return { ok: false, message: '未指定成员' }

      const actor = adminActor(req)
      const updated = []
      for (const id of ids.slice(0, 50)) {
        const [[before]] = await pool.query(
          `SELECT last_training_date FROM members WHERE id = ?`,
          [id]
        )
        const [r] = await pool.query(
          `UPDATE members SET last_training_date = ? WHERE id = ? AND status != '已退队'`,
          [date, id]
        )
        if (r.affectedRows) {
          await syncProxyCheckinFromTrainingDate(id, date, {
            type: 'admin',
            id: actor.id,
            name: actor.name,
            previousLastTrainingDate: toMySQLDate(before?.last_training_date),
          })
          const [[m]] = await pool.query(
            `SELECT id, nickname, last_training_date FROM members WHERE id = ?`,
            [id]
          )
          if (m) updated.push(m)
        }
      }
      return { ok: true, date, updated_count: updated.length, updated }
    }

    case 'list_stale_members': {
      const days = Math.min(180, Math.max(1, Number(a.days) || 7))
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 30))
      const excludeLeave = a.exclude_on_leave !== false
      const excludeRetention = a.exclude_retention !== false
      const today = shanghaiToday()

      const statusExclude = excludeLeave
        ? `('已退队', '其他', '请假中')`
        : `('已退队', '其他')`

      const [rows] = await pool.query(
        `SELECT m.id, m.nickname, m.qq, m.stage_role, m.last_training_date, m.status,
                CASE WHEN ret.id IS NOT NULL THEN 1 ELSE 0 END AS is_retention
         FROM members m
         LEFT JOIN retention_records ret ON ret.member_id = m.id
         WHERE m.status NOT IN ${statusExclude}
           AND (${excludeRetention ? 'ret.id IS NULL' : '1=1'})
           AND (
             m.last_training_date IS NULL
             OR m.last_training_date < DATE_SUB(?, INTERVAL ? DAY)
           )
         ORDER BY (m.last_training_date IS NULL) DESC, m.last_training_date ASC
         LIMIT ?`,
        [today, days, limit]
      )
      return {
        days,
        exclude_on_leave: excludeLeave,
        exclude_retention: excludeRetention,
        count: rows.length,
        list: rows,
      }
    }

    case 'add_black_point': {
      const reason = String(a.reason || '').trim()
      if (!reason) return { ok: false, message: '黑点原因不能为空' }

      let memberId = Number(a.member_id) || 0
      if (!memberId) {
        const ids = await resolveMemberIds({ nickname: a.nickname, nicknames: a.nicknames })
        if (ids.length === 0) return { ok: false, message: '未找到成员，请先 search_members' }
        if (ids.length > 1) {
          return {
            ok: false,
            message: '匹配到多名成员，请用 member_id 精确指定',
            candidate_ids: ids,
          }
        }
        memberId = ids[0]
      }

      const [[member]] = await pool.query(
        `SELECT id, nickname, qq, status FROM members WHERE id = ? LIMIT 1`,
        [memberId]
      )
      if (!member || member.status === '已退队') {
        return { ok: false, message: '成员不存在或已退队' }
      }

      const actor = adminActor(req)
      if (!actor.id) return { ok: false, message: '无法识别管理员身份' }

      const registerDate = toMySQLDate(a.register_date) || shanghaiToday()
      const [result] = await pool.query(
        `INSERT INTO black_point_records (
          member_id, member_name, qq, reason, register_date,
          recorder_id, recorder_name, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '生效中')`,
        [
          member.id,
          member.nickname,
          member.qq,
          reason,
          registerDate,
          actor.id,
          actor.name,
        ]
      )

      return {
        ok: true,
        black_point_id: result.insertId,
        member_id: member.id,
        member_name: member.nickname,
        reason,
        register_date: registerDate,
        recorder_name: actor.name,
        message: `已为 ${member.nickname} 登记黑点 #${result.insertId}`,
      }
    }

    case 'create_leave': {
      const reason = String(a.reason || '').trim() || '未填写'
      const resolved = resolveLeaveEndDate(a, req?.body?.message)
      if (!resolved.endDate) {
        return { ok: false, message: resolved.error || '结束日期无效', ...resolved }
      }
      const { startDate, endDate } = resolved
      if (endDate < startDate) {
        return { ok: false, message: `结束日期 ${endDate} 不能早于开始日期 ${startDate}` }
      }

      let memberId = Number(a.member_id) || 0
      if (!memberId) {
        const ids = await resolveMemberIds({ nickname: a.nickname, nicknames: a.nicknames })
        if (ids.length === 0) return { ok: false, message: '未找到成员，请先 search_members' }
        if (ids.length > 1) {
          return {
            ok: false,
            message: '匹配到多名成员，请用 member_id 精确指定',
            candidate_ids: ids,
          }
        }
        memberId = ids[0]
      }

      const [[member]] = await pool.query(
        `SELECT id, nickname, qq, status FROM members WHERE id = ? LIMIT 1`,
        [memberId]
      )
      if (!member || member.status === '已退队') {
        return { ok: false, message: '成员不存在或已退队' }
      }

      const [[active]] = await pool.query(
        `SELECT id FROM leave_records
         WHERE member_id = ? AND status IN ('请假中', '待结束审批')
         LIMIT 1`,
        [memberId]
      )
      if (active) {
        return {
          ok: false,
          message: `${member.nickname} 已有进行中的请假，请先结束旧请假再登记`,
          existing_leave_id: active.id,
        }
      }

      const [[diff]] = await pool.query(`SELECT DATEDIFF(?, ?) AS d`, [endDate, startDate])
      const totalDays = Number(diff?.d) + 1
      const actor = adminActor(req)

      const [result] = await pool.query(
        `INSERT INTO leave_records (
          member_id, member_name, qq, reason, start_date, end_date, total_days, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '请假中', ?)`,
        [
          member.id,
          member.nickname,
          member.qq,
          reason,
          startDate,
          endDate,
          totalDays,
          actor.id || null,
        ]
      )

      await pool.query(`UPDATE members SET status = '请假中' WHERE id = ?`, [member.id])

      return {
        ok: true,
        leave_id: result.insertId,
        member_id: member.id,
        member_name: member.nickname,
        reason,
        start_date: startDate,
        end_date: endDate,
        total_days: totalDays,
        status: '请假中',
        date_resolve: resolved.via,
        discarded_end_date: resolved.discarded_end_date || null,
        message: `已为 ${member.nickname} 登记请假 #${result.insertId}：${startDate} 至 ${endDate}，共 ${totalDays} 天`,
      }
    }

    case 'get_member': {
      let memberId = Number(a.member_id) || 0
      if (!memberId) {
        const ids = await resolveMemberIds(a)
        if (ids.length !== 1) {
          return { ok: false, message: ids.length ? '匹配多名成员，请给 member_id' : '未找到成员', ids }
        }
        memberId = ids[0]
      }
      const [[m]] = await pool.query(
        `SELECT id, nickname, qq, game_id, stage_role, status, join_date, last_training_date,
                remarks, is_ziye_assistant, phase3_reached_at
         FROM members WHERE id = ? LIMIT 1`,
        [memberId]
      )
      if (!m) return { ok: false, message: '成员不存在' }
      const [[bp]] = await pool.query(
        `SELECT COUNT(*) AS c FROM black_point_records WHERE member_id = ? AND status = '生效中'`,
        [memberId]
      )
      const [[lv]] = await pool.query(
        `SELECT COUNT(*) AS c FROM leave_records WHERE member_id = ? AND status IN ('请假中','待结束审批')`,
        [memberId]
      )
      const [[ret]] = await pool.query(
        `SELECT COUNT(*) AS c FROM retention_records WHERE member_id = ?`,
        [memberId]
      )
      return {
        ok: true,
        member: m,
        active_black_points: Number(bp?.c) || 0,
        active_leaves: Number(lv?.c) || 0,
        in_retention: Number(ret?.c) > 0,
      }
    }

    case 'update_member': {
      let memberId = Number(a.member_id) || 0
      if (!memberId) {
        const ids = await resolveMemberIds(a)
        if (ids.length !== 1) {
          return { ok: false, message: ids.length ? '匹配多名成员，请给 member_id' : '未找到成员', ids }
        }
        memberId = ids[0]
      }
      const [[before]] = await pool.query(
        `SELECT id, nickname, status, stage_role, remarks FROM members WHERE id = ?`,
        [memberId]
      )
      if (!before) return { ok: false, message: '成员不存在' }

      const nextStatus = a.status != null ? String(a.status).trim() : ''
      if (
        before.status === '请假中' &&
        nextStatus &&
        nextStatus !== '请假中'
      ) {
        return {
          ok: false,
          message:
            `不能用 update_member 把「请假中」改成「${nextStatus}」来结束请假。` +
            `请改调 end_leave（nickname 或 member_id），否则请假记录仍在，实际未销假。`,
        }
      }

      const sets = []
      const vals = []
      if (nextStatus) {
        sets.push('status = ?')
        vals.push(nextStatus)
      }
      if (a.stage_role != null && String(a.stage_role).trim()) {
        sets.push('stage_role = ?')
        vals.push(String(a.stage_role).trim())
      }
      if (Object.prototype.hasOwnProperty.call(a, 'remarks')) {
        sets.push('remarks = ?')
        vals.push(a.remarks == null ? null : String(a.remarks))
      }
      if (!sets.length) return { ok: false, message: '未提供可更新字段（status/stage_role/remarks）' }

      vals.push(memberId)
      await pool.query(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`, vals)

      if (String(a.stage_role || '').trim() === '紫夜助教') {
        await pool.query('UPDATE members SET is_ziye_assistant = 1 WHERE id = ?', [memberId])
      }

      const [[after]] = await pool.query(
        `SELECT id, nickname, status, stage_role, remarks, is_ziye_assistant FROM members WHERE id = ?`,
        [memberId]
      )
      return {
        ok: true,
        before,
        after,
        message: `已更新 ${after.nickname}：状态 ${before.status}→${after.status}，阶段 ${before.stage_role}→${after.stage_role}`,
      }
    }

    case 'list_leaves': {
      const activeOnly = a.active_only !== false
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 30))
      let memberId = Number(a.member_id) || 0
      if (!memberId && (a.nickname || a.nicknames)) {
        const ids = await resolveMemberIds(a)
        if (ids.length === 1) memberId = ids[0]
        else if (ids.length > 1) return { ok: false, message: '匹配多名成员', ids }
      }
      const params = []
      let where = 'WHERE m.status != \'已退队\''
      if (activeOnly) {
        where += ` AND lr.status IN ('请假中','待结束审批')`
      }
      if (memberId) {
        where += ' AND lr.member_id = ?'
        params.push(memberId)
      }
      params.push(limit)
      const [rows] = await pool.query(
        `SELECT lr.id, lr.member_id, lr.member_name, lr.qq, lr.reason,
                lr.start_date, lr.end_date, lr.total_days, lr.status,
                DATEDIFF(lr.end_date, CURDATE()) AS remaining_days
         FROM leave_records lr
         LEFT JOIN members m ON m.id = lr.member_id
         ${where}
         ORDER BY lr.start_date DESC, lr.id DESC
         LIMIT ?`,
        params
      )
      return { ok: true, active_only: activeOnly, count: rows.length, list: rows }
    }

    case 'update_leave': {
      const leaveId = Number(a.leave_id)
      if (!leaveId) return { ok: false, message: '缺少 leave_id' }
      const [[leave]] = await pool.query(`SELECT * FROM leave_records WHERE id = ?`, [leaveId])
      if (!leave) return { ok: false, message: '请假记录不存在' }
      const startDate = toMySQLDate(a.start_date) || toMySQLDate(leave.start_date)
      const endDate = toMySQLDate(a.end_date) || toMySQLDate(leave.end_date)
      if (!startDate || !endDate) return { ok: false, message: '日期无效' }
      if (endDate < startDate) return { ok: false, message: '结束日期不能早于开始日期' }
      const reason =
        a.reason != null ? String(a.reason) : leave.reason || ''
      const [[diff]] = await pool.query(`SELECT DATEDIFF(?, ?) AS d`, [endDate, startDate])
      const totalDays = Math.max(1, Number(diff?.d) + 1)
      await pool.query(
        `UPDATE leave_records SET reason = ?, start_date = ?, end_date = ?, total_days = ? WHERE id = ?`,
        [reason, startDate, endDate, totalDays, leaveId]
      )
      return {
        ok: true,
        leave_id: leaveId,
        start_date: startDate,
        end_date: endDate,
        total_days: totalDays,
        message: `已更新请假 #${leaveId}：${startDate} 至 ${endDate}，共 ${totalDays} 天`,
      }
    }

    case 'delete_leave': {
      let leaveId = Number(a.leave_id) || 0
      if (!leaveId) {
        let memberId = Number(a.member_id) || 0
        if (!memberId) {
          const ids = await resolveMemberIds(a)
          if (ids.length !== 1) {
            return { ok: false, message: ids.length ? '匹配多名成员' : '未找到成员', ids }
          }
          memberId = ids[0]
        }
        const onlyActive = a.only_active === true
        const [rows] = await pool.query(
          onlyActive
            ? `SELECT id FROM leave_records
               WHERE member_id = ? AND status IN ('请假中','待结束审批')
               ORDER BY id DESC LIMIT 1`
            : `SELECT id FROM leave_records WHERE member_id = ? ORDER BY id DESC LIMIT 1`,
          [memberId]
        )
        if (!rows.length) return { ok: false, message: '没有可删除的请假记录' }
        leaveId = rows[0].id
      }

      const [[leave]] = await pool.query(`SELECT * FROM leave_records WHERE id = ?`, [leaveId])
      if (!leave) return { ok: false, message: '请假记录不存在' }

      await pool.query(`DELETE FROM leave_records WHERE id = ?`, [leaveId])
      const [[active]] = await pool.query(
        `SELECT COUNT(*) AS c FROM leave_records
         WHERE member_id = ? AND status IN ('请假中','待结束审批')`,
        [leave.member_id]
      )
      if (Number(active?.c) === 0) {
        await pool.query(`UPDATE members SET status = '正常' WHERE id = ? AND status = '请假中'`, [
          leave.member_id,
        ])
      }
      return {
        ok: true,
        leave_id: leaveId,
        member_id: leave.member_id,
        member_name: leave.member_name,
        deleted_status: leave.status,
        message: `已删除 ${leave.member_name} 的请假记录 #${leaveId}（原状态：${leave.status}）`,
      }
    }

    case 'end_leave': {
      let leaveId = Number(a.leave_id) || 0
      if (!leaveId) {
        let memberId = Number(a.member_id) || 0
        if (!memberId) {
          const ids = await resolveMemberIds(a)
          if (ids.length !== 1) {
            return { ok: false, message: ids.length ? '匹配多名成员' : '未找到成员', ids }
          }
          memberId = ids[0]
        }
        const [[row]] = await pool.query(
          `SELECT id FROM leave_records
           WHERE member_id = ? AND status IN ('请假中','待结束审批')
           ORDER BY id DESC LIMIT 1`,
          [memberId]
        )
        if (!row) return { ok: false, message: '该成员没有进行中的请假，无法结束' }
        leaveId = row.id
      }

      const [[leave]] = await pool.query(`SELECT * FROM leave_records WHERE id = ?`, [leaveId])
      if (!leave) return { ok: false, message: '请假记录不存在' }
      if (!['请假中', '待结束审批'].includes(leave.status)) {
        return { ok: false, message: `请假状态为「${leave.status}」，无法结束` }
      }

      const actor = adminActor(req)
      const today = shanghaiToday()
      const startDate = toMySQLDate(leave.start_date) || today
      // 提前结束：结束日改为今天（不早于开始日）
      const endDate = today < startDate ? startDate : today
      const [[diff]] = await pool.query(`SELECT DATEDIFF(?, ?) AS d`, [endDate, startDate])
      const totalDays = Math.max(1, Number(diff?.d) + 1)

      try {
        const [upd] = await pool.query(
          `UPDATE leave_records SET
             status = '已结束',
             end_date = ?,
             total_days = ?,
             buffer_start_date = ?,
             end_approver_name = ?
           WHERE id = ? AND status IN ('请假中','待结束审批')`,
          [endDate, totalDays, today, actor.name || '管理员', leaveId]
        )
        if (!upd.affectedRows) {
          return { ok: false, message: '更新请假记录失败（可能已被结束）' }
        }
      } catch (e) {
        // 兼容未迁移 buffer 字段的库
        const [upd] = await pool.query(
          `UPDATE leave_records SET
             status = '已结束',
             end_date = ?,
             total_days = ?
           WHERE id = ? AND status IN ('请假中','待结束审批')`,
          [endDate, totalDays, leaveId]
        )
        if (!upd.affectedRows) {
          return { ok: false, message: `结束请假失败：${e.message || e}` }
        }
      }

      const [[afterLeave]] = await pool.query(
        `SELECT id, status, start_date, end_date, total_days FROM leave_records WHERE id = ?`,
        [leaveId]
      )
      if (!afterLeave || afterLeave.status !== '已结束') {
        return { ok: false, message: '数据库核对失败：请假仍未变为已结束' }
      }

      const [[active]] = await pool.query(
        `SELECT COUNT(*) AS c FROM leave_records
         WHERE member_id = ? AND status IN ('请假中','待结束审批')`,
        [leave.member_id]
      )
      if (Number(active?.c) === 0) {
        await pool.query(`UPDATE members SET status = '正常' WHERE id = ?`, [leave.member_id])
      }

      const [[mem]] = await pool.query(
        `SELECT id, nickname, status FROM members WHERE id = ?`,
        [leave.member_id]
      )

      return {
        ok: true,
        leave_id: leaveId,
        member_id: leave.member_id,
        member_name: leave.member_name || mem?.nickname,
        member_status: mem?.status,
        start_date: toMySQLDate(afterLeave.start_date),
        end_date: toMySQLDate(afterLeave.end_date),
        total_days: afterLeave.total_days,
        leave_status: afterLeave.status,
        message:
          `已结束 ${leave.member_name || mem?.nickname} 的请假 #${leaveId}` +
          `（${toMySQLDate(afterLeave.start_date)} 至 ${toMySQLDate(afterLeave.end_date)}，共 ${afterLeave.total_days} 天），` +
          `成员状态现为「${mem?.status || '?'}」，并进入 7 天缓冲期`,
      }
    }

    case 'list_black_points': {
      const activeOnly = a.active_only !== false
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 30))
      let memberId = Number(a.member_id) || 0
      if (!memberId && (a.nickname || a.nicknames)) {
        const ids = await resolveMemberIds(a)
        if (ids.length === 1) memberId = ids[0]
        else if (ids.length > 1) return { ok: false, message: '匹配多名成员', ids }
      }
      const params = []
      let where = 'WHERE 1=1'
      if (activeOnly) {
        where += ` AND bp.status = '生效中'`
      }
      if (memberId) {
        where += ' AND bp.member_id = ?'
        params.push(memberId)
      }
      params.push(limit)
      const [rows] = await pool.query(
        `SELECT bp.id, bp.member_id, bp.member_name, bp.qq, bp.reason,
                bp.register_date, bp.status, bp.recorder_name, bp.invalid_date
         FROM black_point_records bp
         ${where}
         ORDER BY bp.register_date DESC, bp.id DESC
         LIMIT ?`,
        params
      )
      return { ok: true, active_only: activeOnly, count: rows.length, list: rows }
    }

    case 'invalidate_black_point': {
      const id = Number(a.black_point_id)
      if (!id) return { ok: false, message: '缺少 black_point_id' }
      const [[row]] = await pool.query(`SELECT * FROM black_point_records WHERE id = ?`, [id])
      if (!row) return { ok: false, message: '黑点记录不存在' }
      if (row.status !== '生效中') {
        return { ok: false, message: `该黑点已是「${row.status}」` }
      }
      // 库表 ENUM 为 生效中 / 已失效（不是「已作废」）
      await pool.query(
        `UPDATE black_point_records SET status = '已失效', invalid_date = CURDATE() WHERE id = ?`,
        [id]
      )
      return {
        ok: true,
        black_point_id: id,
        member_name: row.member_name,
        message: `已将 ${row.member_name} 的黑点 #${id} 设为已失效`,
      }
    }

    case 'delete_black_points': {
      const bpId = Number(a.black_point_id)
      const memberId = Number(a.member_id)
      const nick = String(a.nickname || '').trim()
      const activeOnly = a.active_only === true

      if (bpId) {
        const [[row]] = await pool.query(`SELECT * FROM black_point_records WHERE id = ?`, [bpId])
        if (!row) return { ok: false, message: '黑点记录不存在' }
        await pool.query(`DELETE FROM black_point_records WHERE id = ?`, [bpId])
        return {
          ok: true,
          deleted: 1,
          black_point_ids: [bpId],
          member_name: row.member_name,
          message: `已删除 ${row.member_name} 的黑点记录 #${bpId}`,
        }
      }

      let mid = memberId || 0
      if (!mid && nick) {
        const [hits] = await pool.query(
          `SELECT id, nickname FROM members WHERE nickname LIKE ? AND status != '已退队' LIMIT 10`,
          [`%${nick}%`]
        )
        if (!hits.length) return { ok: false, message: `未找到昵称含「${nick}」的成员` }
        if (hits.length > 1) {
          return {
            ok: false,
            message: '匹配到多名成员，请指定 member_id',
            candidates: hits,
          }
        }
        mid = Number(hits[0].id)
      }
      if (!mid) {
        return { ok: false, message: '请提供 black_point_id，或 member_id / nickname' }
      }

      const [[mem]] = await pool.query(
        `SELECT id, nickname FROM members WHERE id = ? LIMIT 1`,
        [mid]
      )
      if (!mem) return { ok: false, message: '成员不存在' }

      let where = 'member_id = ?'
      const params = [mid]
      if (activeOnly) {
        where += ` AND status = '生效中'`
      }
      const [rows] = await pool.query(
        `SELECT id, reason, status, register_date FROM black_point_records WHERE ${where}`,
        params
      )
      if (!rows.length) {
        return {
          ok: false,
          message: activeOnly
            ? `${mem.nickname} 没有生效中的黑点`
            : `${mem.nickname} 没有黑点记录`,
        }
      }
      const ids = rows.map((r) => r.id)
      await pool.query(
        `DELETE FROM black_point_records WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      )
      return {
        ok: true,
        deleted: ids.length,
        black_point_ids: ids,
        member_id: mid,
        member_name: mem.nickname,
        message: `已删除 ${mem.nickname} 的 ${ids.length} 条黑点记录`,
      }
    }

    case 'list_retention': {
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 50))
      const [rows] = await pool.query(
        `SELECT rr.id, rr.member_id, m.nickname, m.qq, m.stage_role, m.status,
                rr.retention_reason, rr.approver_name, rr.created_at
         FROM retention_records rr
         LEFT JOIN members m ON m.id = rr.member_id
         ORDER BY rr.id DESC
         LIMIT ?`,
        [limit]
      )
      return { ok: true, count: rows.length, list: rows }
    }

    case 'count_quit_pending': {
      const [rows] = await pool.query(
        `SELECT qa.id, qa.member_id, qa.member_name, qa.qq, qa.reason, qa.status, qa.apply_date
         FROM quit_approvals qa
         WHERE qa.status = '待审批'
         ORDER BY qa.id DESC
         LIMIT ?`,
        [Math.min(100, Math.max(1, Number(a.limit) || 50))]
      )
      return {
        ok: true,
        count: rows.length,
        list: a.list === false ? [] : rows,
      }
    }

    case 'list_training_reminders': {
      const cfg = await loadReminderConfig()
      const rows = await queryTrainingReminders(cfg.defaultTimeoutDays, cfg.trainingWarnDays, {
        includeLeaveBuffer: false,
      })
      const limit = Math.min(80, Math.max(1, Number(a.limit) || 40))
      const list = (rows || []).slice(0, limit).map((r) => ({
        member_id: r.member_id || r.id,
        member_name: r.member_name || r.nickname,
        stage_role: r.stage_role,
        last_training_date: r.last_training_date,
        days_without_training: r.days_without_training,
        days_until_timeout: r.days_until_timeout,
      }))
      return { ok: true, count: list.length, total_matched: (rows || []).length, list }
    }

    case 'list_progress_reminders': {
      const ctx = await loadAttendanceContext()
      const rows = buildAttendanceList(ctx, { showAll: a.show_all === true })
      const limit = Math.min(80, Math.max(1, Number(a.limit) || 40))
      const list = rows.slice(0, limit).map((r) => ({
        member_id: r.member_id,
        member_name: r.member_name || r.nickname,
        stage_role: r.stage_role,
        reason_title: r.reason_title || r.title,
        reason_code: r.reason_code,
        remaining_days: r.remaining_days,
        elapsed_days: r.elapsed_days,
      }))
      return {
        ok: true,
        tab_name: '进度催促',
        note: '进度催促=升期/闲置规则链；训练催促=未训超时倒计时，二者不同。',
        count: list.length,
        total_matched: rows.length,
        list,
      }
    }

    case 'batch_set_training_quit_date': {
      const cfg = await loadReminderConfig()
      const rows = await queryTrainingReminders(cfg.defaultTimeoutDays, cfg.trainingWarnDays, {
        includeLeaveBuffer: false,
      })
      const targets = filterByStageNick(rows, a, 'member_name')
      if (!targets.length) {
        return { ok: false, message: '筛选后训练催促名单为空，未改任何人' }
      }

      let remaining = null
      if (a.remaining_days != null && a.remaining_days !== '') {
        remaining = Math.max(0, Number(a.remaining_days))
      } else if (a.quit_date) {
        const qd = toMySQLDate(a.quit_date)
        if (!qd) return { ok: false, message: 'quit_date 无效' }
        remaining = Math.max(0, daysFromTodayToYmd(qd))
      } else {
        return { ok: false, message: '请提供 quit_date 或 remaining_days' }
      }

      const updated = []
      for (const r of targets) {
        const mid = Number(r.member_id || r.id)
        const daysWithout = Number(r.days_without_training) || 0
        const customDays = Math.max(1, daysWithout + remaining)
        await upsertTrainingCustomTimeout(mid, customDays)
        updated.push({
          member_id: mid,
          member_name: r.member_name || r.nickname,
          stage_role: r.stage_role,
          remaining_days: remaining,
          custom_timeout_days: customDays,
        })
      }
      return {
        ok: true,
        remaining_days: remaining,
        count: updated.length,
        list: updated.slice(0, 40),
        message: `已为训练催促名单中 ${updated.length} 人设定还剩 ${remaining} 天（希望退队日约 ${addDaysYmd(shanghaiToday(), remaining)}）`,
      }
    }

    case 'batch_set_progress_quit_date': {
      await ensureAttendanceOverrideTable()
      const ctx = await loadAttendanceContext()
      const rows = buildAttendanceList(ctx, { showAll: false })
      const targets = filterByStageNick(rows, a, 'member_name')
      if (!targets.length) {
        return { ok: false, message: '筛选后进度催促名单为空，未改任何人' }
      }

      let remaining = null
      if (a.remaining_days != null && a.remaining_days !== '') {
        remaining = Math.max(0, Number(a.remaining_days))
      } else if (a.quit_date) {
        const qd = toMySQLDate(a.quit_date)
        if (!qd) return { ok: false, message: 'quit_date 无效' }
        remaining = Math.max(0, daysFromTodayToYmd(qd))
      } else {
        return { ok: false, message: '请提供 quit_date 或 remaining_days' }
      }

      let updated = 0
      const sample = []
      for (const item of targets) {
        const mid = Number(item.member_id)
        const member = ctx.members.find((m) => m.id === mid)
        if (!member) continue
        const fresh = computeAttendanceForMember(member, ctx.leaveMap.get(mid) || [], {
          ignored: false,
          inRetention: !!member.in_retention,
          showAll: true,
          overrides: {},
          formalTimeoutDays: ctx.formalTimeoutDays || 0,
          useFormal180: ctx.use180Set?.has(Number(mid)),
          rulesConfig: ctx.rulesConfig,
        })
        if (!fresh) continue
        const customDeadline = Math.max(1, Number(fresh.elapsed_days) + remaining)
        await pool.query(
          `INSERT INTO attendance_reminder_overrides (member_id, reason_code, custom_deadline_days)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE custom_deadline_days = VALUES(custom_deadline_days)`,
          [mid, fresh.reason_code, customDeadline]
        )
        updated += 1
        if (sample.length < 30) {
          sample.push({
            member_id: mid,
            member_name: item.member_name || member.nickname,
            stage_role: member.stage_role,
            remaining_days: remaining,
          })
        }
      }
      return {
        ok: true,
        remaining_days: remaining,
        count: updated,
        list: sample,
        message: `已为进度催促名单中 ${updated} 人设定还剩 ${remaining} 天（希望退队日约 ${addDaysYmd(shanghaiToday(), remaining)}）`,
      }
    }

    case 'get_reminder_rules': {
      const config = await loadReminderRulesConfig()
      return {
        ok: true,
        naming: {
          training: '训练催促（未训超时）',
          progress: '进度催促（升期/闲置规则链，原「考勤催促」）',
          formal: '正式队员短周期考勤（走训练催促常驻倒计时）',
        },
        tip:
          '改「升到三期/准考/半年新训」天数请用 update_reminder_rules：rule_query + rule_deadline_days。' +
          'progress_warn_days 只是进名单预警阈值，不是升期时限。',
        progress_rules: summarizeProgressRules(config),
        config,
      }
    }

    case 'update_reminder_rules': {
      const config = await loadReminderRulesConfig()
      const next = JSON.parse(JSON.stringify(config))
      const changed = []
      if (a.default_timeout_days != null) {
        next.training.defaultTimeoutDays = Math.max(1, Number(a.default_timeout_days) || 1)
        changed.push(`新训默认超时→${next.training.defaultTimeoutDays}天`)
      }
      if (a.formal_timeout_days != null) {
        next.training.formalTimeoutDays = Math.max(0, Number(a.formal_timeout_days) || 0)
        changed.push(`正式队员短周期→${next.training.formalTimeoutDays}天`)
      }
      if (a.training_warn_days != null) {
        next.training.warnDays = Math.max(0, Number(a.training_warn_days) || 0)
        changed.push(`训练预警→${next.training.warnDays}天`)
      }
      if (a.progress_warn_days != null || a.attendance_warn_days != null) {
        next.attendance.warnDays = Math.max(
          0,
          Number(a.progress_warn_days ?? a.attendance_warn_days) || 0
        )
        changed.push(`进度催促预警→${next.attendance.warnDays}天`)
      }

      const ruleQuery = a.rule_query ?? a.rule_id ?? a.rule_match ?? a.rule_title
      const wantsRulePatch =
        ruleQuery != null ||
        a.rule_deadline_days != null ||
        a.rule_enabled != null ||
        a.rule_cap_from_join_days != null ||
        a.rule_title != null

      if (wantsRulePatch) {
        if (!ruleQuery) {
          return {
            ok: false,
            message:
              '改进度规则链需要 rule_query（如「升到三期」或 to_phase3）。可先 get_reminder_rules 看 progress_rules。',
          }
        }
        const idx = findAttendanceRuleIndex(next.attendance.rules, ruleQuery)
        if (idx < 0) {
          return {
            ok: false,
            message: `未找到规则「${ruleQuery}」。可用 get_reminder_rules 查看 progress_rules 的 id/title。`,
            progress_rules: summarizeProgressRules(next),
          }
        }
        const rule = next.attendance.rules[idx]
        const titleBefore = resolveRuleTitle(rule) || rule.title || rule.id
        if (a.rule_deadline_days != null) {
          const days = Math.max(1, Math.min(3650, Math.floor(Number(a.rule_deadline_days) || 0)))
          if (!days) {
            return { ok: false, message: 'rule_deadline_days 无效' }
          }
          rule.deadlineDays = days
          changed.push(`「${titleBefore}」时限→${days}天`)
        }
        if (a.rule_enabled != null) {
          rule.enabled = Boolean(a.rule_enabled)
          changed.push(`「${titleBefore}」${rule.enabled ? '已启用' : '已关闭'}`)
        }
        if (a.rule_cap_from_join_days != null && rule.type === 'until_stage') {
          const cap = Number(a.rule_cap_from_join_days)
          rule.capFromJoinDays = !Number.isFinite(cap) || cap <= 0 ? null : Math.floor(cap)
          changed.push(
            rule.capFromJoinDays == null
              ? `「${titleBefore}」已清除加入日总上限`
              : `「${titleBefore}」加入日总上限→${rule.capFromJoinDays}天`
          )
        }
        if (a.rule_title != null && String(a.rule_title).trim()) {
          rule.title = String(a.rule_title).trim().slice(0, 40)
          changed.push(`规则标题→「${rule.title}」`)
        }
        rule.label = buildAutoRuleLabel(rule)
        next.attendance.rules[idx] = rule
      }

      if (!changed.length) {
        return {
          ok: false,
          message:
            '未提供可改字段。改升期时限请传 rule_query + rule_deadline_days；' +
            '改预警/短周期请传对应 *_days。',
        }
      }

      const saved = await saveReminderRulesConfig(next)
      return {
        ok: true,
        changed,
        progress_rules: summarizeProgressRules(saved),
        config: saved,
        message: `规则已更新：${changed.join('；')}。`,
      }
    }

    case 'list_quit_approvals': {
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 50))
      const status = a.status ? String(a.status).trim() : ''
      const params = []
      let where = `WHERE qa.status != '已批准'`
      if (status) {
        where += ' AND qa.status = ?'
        params.push(status)
      }
      params.push(limit)
      const [rows] = await pool.query(
        `SELECT qa.id, qa.member_id, qa.member_name, qa.qq, qa.status, qa.remarks,
                qa.apply_date, qa.source_type, qa.approver_name, qa.approval_date
         FROM quit_approvals qa
         ${where}
         ORDER BY qa.apply_date DESC, qa.id DESC
         LIMIT ?`,
        params
      )
      return { ok: true, count: rows.length, list: rows }
    }

    case 'create_quit_approval': {
      const remarks = String(a.remarks || '').trim()
      if (!remarks) return { ok: false, message: '请填写退队原因 remarks' }
      let memberId = Number(a.member_id) || 0
      if (!memberId) {
        const ids = await resolveMemberIds(a)
        if (ids.length !== 1) {
          return { ok: false, message: ids.length ? '匹配多名成员，请给 member_id' : '未找到成员', ids }
        }
        memberId = ids[0]
      }
      const [[m]] = await pool.query(
        `SELECT id, nickname, qq, status FROM members WHERE id = ?`,
        [memberId]
      )
      if (!m) return { ok: false, message: '成员不存在' }
      const [existing] = await pool.query(
        `SELECT id FROM quit_approvals WHERE member_id = ? AND status = '待审批' LIMIT 1`,
        [memberId]
      )
      if (existing.length) {
        return { ok: false, message: `${m.nickname} 已有待审批退队记录 #${existing[0].id}` }
      }
      const actor = adminActor(req)
      const [result] = await pool.query(
        `INSERT INTO quit_approvals (
          member_id, member_name, qq, apply_date, source_type,
          source_admin_id, source_admin_name, status, remarks
        ) VALUES (?, ?, ?, ?, '手动', ?, ?, '待审批', ?)`,
        [memberId, m.nickname, m.qq, shanghaiToday(), actor.id, actor.name, remarks]
      )
      return {
        ok: true,
        quit_id: result.insertId,
        member_id: memberId,
        member_name: m.nickname,
        message: `已为 ${m.nickname} 创建退队审批 #${result.insertId}`,
      }
    }

    case 'review_quit_approvals': {
      const action = String(a.action || '').toLowerCase()
      if (action !== 'approve' && action !== 'reject') {
        return { ok: false, message: 'action 须为 approve 或 reject' }
      }
      const ids = await resolveQuitApprovalIds(a)
      if (!ids.length) return { ok: false, message: '未找到待处理的退队审批' }
      const actor = adminActor(req)
      const nextStatus = action === 'approve' ? '已批准' : '已拒绝'
      const done = []
      const skipped = []
      for (const id of ids) {
        const [[row]] = await pool.query(`SELECT * FROM quit_approvals WHERE id = ?`, [id])
        if (!row) {
          skipped.push({ id, reason: '不存在' })
          continue
        }
        if (row.status !== '待审批') {
          skipped.push({ id, member_name: row.member_name, reason: `当前状态 ${row.status}` })
          continue
        }
        await pool.query(
          `UPDATE quit_approvals SET
            status = ?, approver_id = ?, approver_name = ?, approval_date = ?,
            remarks = ?
           WHERE id = ?`,
          [
            nextStatus,
            actor.id,
            actor.name,
            shanghaiToday(),
            a.remarks != null ? String(a.remarks) : row.remarks,
            id,
          ]
        )
        if (action === 'approve') {
          await pool.query(`UPDATE members SET status = '已退队' WHERE id = ?`, [row.member_id])
        } else {
          await pool.query(
            `UPDATE members SET status = '正常' WHERE id = ? AND status != '请假中'`,
            [row.member_id]
          )
        }
        done.push({ id, member_id: row.member_id, member_name: row.member_name, status: nextStatus })
      }
      return {
        ok: done.length > 0,
        action: nextStatus,
        count: done.length,
        list: done,
        skipped,
        message: done.length
          ? `已${nextStatus} ${done.length} 条退队审批`
          : '没有成功处理的记录',
      }
    }

    case 'delete_quit_approvals': {
      const ids = await resolveQuitApprovalIds({
        ...a,
        quit_ids: a.quit_ids ?? a.ids,
      })
      // 删除时也允许非待审批：若只给了 quit_ids 直接用；若按成员解析则上面只拿到待审批
      let targetIds = normalizeIdList(a.quit_ids ?? a.ids)
      if (!targetIds.length) targetIds = ids
      if (!targetIds.length) return { ok: false, message: '未指定要删除的退队审批' }
      const done = []
      for (const id of targetIds) {
        const [[row]] = await pool.query(`SELECT * FROM quit_approvals WHERE id = ?`, [id])
        if (!row) continue
        await pool.query(`DELETE FROM quit_approvals WHERE id = ?`, [id])
        if (row.status === '待审批') {
          await pool.query(
            `UPDATE members SET status = '正常' WHERE id = ? AND status != '请假中'`,
            [row.member_id]
          )
        }
        done.push({ id, member_name: row.member_name })
      }
      return {
        ok: done.length > 0,
        count: done.length,
        list: done,
        message: done.length ? `已删除 ${done.length} 条退队审批` : '未删除任何记录',
      }
    }

    case 'create_retention': {
      const reason = String(a.retention_reason || '').trim()
      if (!reason) return { ok: false, message: '请提供 retention_reason' }
      let memberId = Number(a.member_id) || 0
      if (!memberId) {
        const ids = await resolveMemberIds(a)
        if (ids.length !== 1) {
          return { ok: false, message: ids.length ? '匹配多名成员，请给 member_id' : '未找到成员', ids }
        }
        memberId = ids[0]
      }
      const [[m]] = await pool.query(
        `SELECT id, nickname, qq, stage_role, last_training_date FROM members WHERE id = ?`,
        [memberId]
      )
      if (!m) return { ok: false, message: '成员不存在' }
      const actor = adminActor(req)
      const [result] = await pool.query(
        `INSERT INTO retention_records (
          member_id, member_name, qq, stage_role, last_training_date,
          retention_reason, approver_remarks, approver_id, approver_name, approval_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          memberId,
          m.nickname,
          m.qq,
          m.stage_role,
          m.last_training_date,
          reason,
          a.approver_remarks != null ? String(a.approver_remarks) : '',
          actor.id,
          actor.name,
          shanghaiToday(),
        ]
      )
      await pool.query(`DELETE FROM reminder_list WHERE member_id = ?`, [memberId])
      return {
        ok: true,
        retention_id: result.insertId,
        member_name: m.nickname,
        message: `已为 ${m.nickname} 添加留队记录 #${result.insertId}`,
      }
    }

    case 'delete_retention': {
      let ids = normalizeIdList(a.retention_ids ?? a.ids)
      if (!ids.length) {
        const memberIds = await resolveMemberIds(a)
        if (!memberIds.length) return { ok: false, message: '未指定留队记录' }
        const ph = memberIds.map(() => '?').join(',')
        const [rows] = await pool.query(
          `SELECT id FROM retention_records WHERE member_id IN (${ph}) ORDER BY id DESC`,
          memberIds
        )
        ids = rows.map((r) => Number(r.id))
      }
      if (!ids.length) return { ok: false, message: '未找到留队记录' }
      let deleted = 0
      for (const id of ids) {
        const [r] = await pool.query(`DELETE FROM retention_records WHERE id = ?`, [id])
        if (r.affectedRows) deleted += 1
      }
      return {
        ok: deleted > 0,
        count: deleted,
        message: deleted ? `已删除 ${deleted} 条留队记录` : '未删除任何记录',
      }
    }

    case 'batch_update_members': {
      const ids = await resolveMemberIds(a)
      if (!ids.length) return { ok: false, message: '未指定成员' }
      const hasStatus = a.status != null && String(a.status).trim()
      const hasStage = a.stage_role != null && String(a.stage_role).trim()
      const hasTrain = Object.prototype.hasOwnProperty.call(a, 'last_training_date')
      if (!hasStatus && !hasStage && !hasTrain) {
        return { ok: false, message: '请提供 status / stage_role / last_training_date 至少一项' }
      }
      const nextStatus = hasStatus ? String(a.status).trim() : ''
      const nextStage = hasStage ? String(a.stage_role).trim() : ''
      const trainDate = hasTrain
        ? a.last_training_date == null || a.last_training_date === ''
          ? null
          : toMySQLDate(a.last_training_date)
        : undefined
      if (hasTrain && a.last_training_date && !trainDate) {
        return { ok: false, message: 'last_training_date 无效' }
      }
      const updated = []
      const skipped = []
      for (const mid of ids) {
        const [[before]] = await pool.query(
          `SELECT id, nickname, status, stage_role, last_training_date FROM members WHERE id = ?`,
          [mid]
        )
        if (!before) {
          skipped.push({ member_id: mid, reason: '不存在' })
          continue
        }
        if (before.status === '请假中' && nextStatus && nextStatus !== '请假中') {
          skipped.push({
            member_id: mid,
            member_name: before.nickname,
            reason: '请假中请用 end_leave，不能直接改状态',
          })
          continue
        }
        const sets = []
        const vals = []
        if (nextStatus) {
          sets.push('status = ?')
          vals.push(nextStatus)
        }
        if (nextStage) {
          sets.push('stage_role = ?')
          vals.push(nextStage)
        }
        if (hasTrain) {
          sets.push('last_training_date = ?')
          vals.push(trainDate)
        }
        vals.push(mid)
        await pool.query(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`, vals)
        if (nextStage === '紫夜助教') {
          await pool.query(`UPDATE members SET is_ziye_assistant = 1 WHERE id = ?`, [mid])
        }
        updated.push({
          member_id: mid,
          member_name: before.nickname,
          before_status: before.status,
          before_stage: before.stage_role,
        })
      }
      return {
        ok: updated.length > 0,
        count: updated.length,
        list: updated.slice(0, 40),
        skipped,
        message: updated.length
          ? `已更新 ${updated.length} 名成员`
          : '没有成功更新的成员',
      }
    }

    case 'list_assessment_applications': {
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 40))
      const status = a.status ? String(a.status).trim() : ''
      const params = []
      let where = 'WHERE 1=1'
      if (status) {
        where += ' AND aa.status = ?'
        params.push(status)
      }
      params.push(limit)
      const [rows] = await pool.query(
        `SELECT aa.id, aa.member_id, aa.member_name, m.qq, aa.companion,
                aa.preferred_date, aa.preferred_time, aa.status,
                aa.admission_ticket, aa.reject_reason, aa.approved_by
         FROM assessment_applications aa
         LEFT JOIN members m ON m.id = aa.member_id
         ${where}
         ORDER BY (aa.status = '待审批') DESC, aa.id DESC
         LIMIT ?`,
        params
      )
      return {
        ok: true,
        note: '考核审批；不含反作弊相关功能',
        count: rows.length,
        list: rows,
      }
    }

    case 'review_assessment_applications': {
      const action = String(a.action || '').toLowerCase()
      if (action !== 'approve' && action !== 'reject') {
        return { ok: false, message: 'action 须为 approve 或 reject' }
      }
      if (action === 'reject' && !String(a.reject_reason || '').trim()) {
        return { ok: false, message: '驳回须提供 reject_reason' }
      }
      let ids = normalizeIdList(a.application_ids ?? a.ids)
      if (!ids.length && (a.nicknames || a.nickname)) {
        const memberIds = await resolveMemberIds(a)
        if (memberIds.length) {
          const ph = memberIds.map(() => '?').join(',')
          const [rows] = await pool.query(
            `SELECT id FROM assessment_applications
             WHERE member_id IN (${ph}) AND status = '待审批'`,
            memberIds
          )
          ids = rows.map((r) => Number(r.id))
        }
      }
      if (!ids.length) return { ok: false, message: '未找到待处理的考核申请' }
      const actor = adminActor(req)
      const done = []
      const skipped = []
      for (const id of ids) {
        const [[row]] = await pool.query(
          `SELECT * FROM assessment_applications WHERE id = ?`,
          [id]
        )
        if (!row) {
          skipped.push({ id, reason: '不存在' })
          continue
        }
        if (row.status !== '待审批') {
          skipped.push({ id, member_name: row.member_name, reason: `当前 ${row.status}` })
          continue
        }
        if (action === 'approve') {
          const ticket = genAdmissionTicket(row.preferred_date)
          await pool.query(
            `UPDATE assessment_applications
             SET status = '已通过', admission_ticket = ?, approved_by = ?, approved_at = NOW()
             WHERE id = ?`,
            [ticket, actor.name, id]
          )
          done.push({
            id,
            member_name: row.member_name,
            status: '已通过',
            admission_ticket: ticket,
          })
        } else {
          await pool.query(
            `UPDATE assessment_applications
             SET status = '已驳回', reject_reason = ?, approved_by = ?, approved_at = NOW()
             WHERE id = ?`,
            [String(a.reject_reason).trim(), actor.name, id]
          )
          done.push({ id, member_name: row.member_name, status: '已驳回' })
        }
      }
      return {
        ok: done.length > 0,
        count: done.length,
        list: done,
        skipped,
        message: done.length
          ? `已处理 ${done.length} 条考核申请`
          : '没有成功处理的申请',
      }
    }

    case 'delete_assessment_applications': {
      const ids = normalizeIdList(a.application_ids ?? a.ids)
      if (!ids.length) return { ok: false, message: '请提供 application_ids' }
      let deleted = 0
      for (const id of ids) {
        const [r] = await pool.query(`DELETE FROM assessment_applications WHERE id = ?`, [id])
        if (r.affectedRows) deleted += 1
      }
      return {
        ok: deleted > 0,
        count: deleted,
        message: deleted ? `已删除 ${deleted} 条考核申请` : '未删除任何记录',
      }
    }

    case 'list_assessments': {
      const limit = Math.min(80, Math.max(1, Number(a.limit) || 30))
      let memberId = Number(a.member_id) || 0
      if (!memberId && (a.nickname || a.nicknames)) {
        const ids = await resolveMemberIds(a)
        if (ids.length === 1) memberId = ids[0]
        else if (ids.length > 1) return { ok: false, message: '匹配多名成员', ids }
      }
      const params = []
      let where = 'WHERE 1=1'
      if (memberId) {
        where += ' AND a.member_id = ?'
        params.push(memberId)
      }
      params.push(limit)
      const [rows] = await pool.query(
        `SELECT a.id, a.member_id, a.member_name, a.assessment_date, a.map, a.status,
                a.evaluation, a.video_url
         FROM assessments a
         ${where}
         ORDER BY a.assessment_date DESC, a.id DESC
         LIMIT ?`,
        params
      )
      return { ok: true, note: '考核记录；不含反作弊', count: rows.length, list: rows }
    }

    case 'list_courses': {
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 50))
      const q = String(a.q || '').trim()
      const params = []
      let where = 'WHERE 1=1'
      if (q) {
        where += ' AND (c.code LIKE ? OR c.name LIKE ? OR c.category LIKE ?)'
        const like = `%${q}%`
        params.push(like, like, like)
      }
      params.push(limit)
      const [rows] = await pool.query(
        `SELECT c.id, c.code, c.name AS title, c.category, c.difficulty, c.hours
         FROM courses c
         ${where}
         ORDER BY c.code ASC
         LIMIT ?`,
        params
      )
      return { ok: true, count: rows.length, list: rows }
    }

    case 'batch_set_course_progress': {
      const progress = Number(a.progress)
      if (![0, 10, 20, 50, 75, 100].includes(progress)) {
        return { ok: false, message: 'progress 必须是 0/10/20/50/75/100' }
      }
      let courseId = Number(a.course_id) || 0
      if (!courseId && a.course_code) {
        const [[c]] = await pool.query(
          `SELECT id, code, name FROM courses WHERE code = ? LIMIT 1`,
          [String(a.course_code).trim()]
        )
        if (!c) return { ok: false, message: `未找到课程 code=${a.course_code}` }
        courseId = Number(c.id)
      }
      if (!courseId) return { ok: false, message: '请提供 course_id 或 course_code' }
      const [[course]] = await pool.query(
        `SELECT id, code, name FROM courses WHERE id = ?`,
        [courseId]
      )
      if (!course) return { ok: false, message: '课程不存在' }
      const memberIds = await resolveMemberIds(a)
      if (!memberIds.length) return { ok: false, message: '未指定成员' }
      for (const mid of memberIds) {
        if (progress === 0) {
          await pool.query(
            `DELETE FROM student_course_progress WHERE member_id = ? AND course_id = ?`,
            [mid, courseId]
          )
        } else {
          await pool.query(
            `INSERT INTO student_course_progress (member_id, course_id, progress)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE progress = ?`,
            [mid, courseId, progress, progress]
          )
        }
      }
      return {
        ok: true,
        course_id: courseId,
        course_code: course.code,
        course_title: course.name,
        progress,
        member_count: memberIds.length,
        message:
          `已为 ${memberIds.length} 人设置课程 ${course.code} 进度为 ${progress}%` +
          '（阶段未自动同步，可在成员列表使用同步阶段）',
      }
    }

    case 'list_assistant_pending': {
      const pendingOnly = a.pending_only !== false
      const typeFilter = String(a.type || '').trim()
      const pendingSql = (alias) =>
        pendingOnly ? `AND ${alias}.status = '待审批'` : ''

      const [assignments] = await pool.query(
        `SELECT a.id, a.status, am.nickname AS assistant_name, sm.nickname AS student_name,
                a.created_at
         FROM assistant_student_assignments a
         LEFT JOIN members am ON am.id = a.assistant_member_id
         LEFT JOIN members sm ON sm.id = a.student_member_id
         WHERE a.requested_by_type = 'assistant'
           AND COALESCE(a.hidden_from_approval, 0) = 0
           ${pendingSql('a')}
         ORDER BY a.id DESC LIMIT 40`
      )
      const [creates] = await pool.query(
        `SELECT p.id, p.status, p.nickname, m.nickname AS assistant_name, p.created_at
         FROM pending_member_creates p
         LEFT JOIN members m ON m.id = p.assistant_member_id
         WHERE 1=1 ${pendingSql('p')}
         ORDER BY p.id DESC LIMIT 40`
      )
      const [promotions] = await pool.query(
        `SELECT p.id, p.status, sm.nickname AS student_name, p.to_stage, p.created_at
         FROM pending_stage_promotions p
         LEFT JOIN members sm ON sm.id = p.student_member_id
         WHERE 1=1 ${pendingSql('p')}
         ORDER BY p.id DESC LIMIT 40`
      )
      const [edits] = await pool.query(
        `SELECT e.id, e.status, sm.nickname AS student_name, e.created_at
         FROM pending_member_edits e
         LEFT JOIN members sm ON sm.id = e.student_member_id
         WHERE 1=1 ${pendingSql('e')}
         ORDER BY e.id DESC LIMIT 40`
      )
      const [blackPoints] = await pool.query(
        `SELECT b.id, b.status, sm.nickname AS student_name, b.reason, b.created_at
         FROM pending_black_points b
         LEFT JOIN members sm ON sm.id = b.student_member_id
         WHERE 1=1 ${pendingSql('b')}
         ORDER BY b.id DESC LIMIT 40`
      )
      const [leaves] = await pool.query(
        `SELECT l.id, l.status, sm.nickname AS student_name, l.reason, l.created_at
         FROM pending_leaves l
         LEFT JOIN members sm ON sm.id = l.student_member_id
         WHERE 1=1 ${pendingSql('l')}
         ORDER BY l.id DESC LIMIT 40`
      )

      const buckets = {
        assignments,
        creates,
        promotions,
        edits,
        blackPoints,
        leaves,
      }
      const counts = Object.fromEntries(
        Object.entries(buckets).map(([k, list]) => [k, (list || []).length])
      )
      if (typeFilter && buckets[typeFilter] != null) {
        return {
          ok: true,
          type: typeFilter,
          count: buckets[typeFilter].length,
          list: buckets[typeFilter],
          note: '助教待审；升期/建档/编辑等复杂审批请在助教管理页操作。可 review_assistant_assignment 审批带学员申请。',
        }
      }
      return {
        ok: true,
        counts,
        pending: buckets,
        note: '仅接入「带学员申请」审批写入；其它类型请到助教管理页处理。不含反作弊。',
      }
    }

    case 'review_assistant_assignment': {
      const id = Number(a.assignment_id)
      const status = a.status === '已通过' ? '已通过' : a.status === '已拒绝' ? '已拒绝' : ''
      if (!id) return { ok: false, message: '请提供 assignment_id' }
      if (!status) return { ok: false, message: 'status 须为 已通过 或 已拒绝' }
      const actor = adminActor(req)
      const [r] = await pool.query(
        `UPDATE assistant_student_assignments
         SET status = ?, reviewed_by_admin_id = ?, reviewed_at = NOW(),
             remarks = COALESCE(?, remarks), hidden_from_approval = 0
         WHERE id = ? AND status = '待审批'`,
        [status, actor.id, a.remarks != null ? String(a.remarks) : null, id]
      )
      if (!r.affectedRows) {
        return { ok: false, message: '记录不存在或不是待审批状态' }
      }
      return { ok: true, assignment_id: id, status, message: `带学员申请 #${id} 已${status}` }
    }

    case 'list_surveys': {
      const limit = Math.min(50, Math.max(1, Number(a.limit) || 20))
      const q = String(a.q || a.title || '').trim()
      const status = String(a.status || '').trim()
      const params = []
      let where = 'WHERE 1=1'
      if (q) {
        where += ' AND title LIKE ?'
        params.push(`%${q}%`)
      }
      if (status && ['draft', 'published', 'closed'].includes(status)) {
        where += ' AND status = ?'
        params.push(status)
      }
      params.push(limit)
      const [rows] = await pool.query(
        `SELECT s.id, s.title, s.status, s.is_anonymous, s.results_public,
                s.start_at, s.end_at, s.max_responses, s.created_at,
                (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS response_count
         FROM surveys s
         ${where}
         ORDER BY s.id DESC
         LIMIT ?`,
        params
      )
      return {
        ok: true,
        count: rows.length,
        list: rows.map((r) => ({
          ...r,
          is_anonymous: !!r.is_anonymous,
          results_public: !!r.results_public,
        })),
        tip: '深入了解填写情况请用 summarize_survey（survey_id 或 title）',
      }
    }

    case 'summarize_survey': {
      let surveyId = Number(a.survey_id) || 0
      if (!surveyId) {
        const title = String(a.title || a.q || '').trim()
        if (!title) return { ok: false, message: '请提供 survey_id 或 title' }
        const [hits] = await pool.query(
          `SELECT id, title FROM surveys WHERE title LIKE ? ORDER BY id DESC LIMIT 5`,
          [`%${title}%`]
        )
        if (!hits.length) return { ok: false, message: `未找到标题含「${title}」的问卷` }
        if (hits.length > 1) {
          return {
            ok: false,
            message: '匹配多张问卷，请指定 survey_id',
            candidates: hits,
          }
        }
        surveyId = Number(hits[0].id)
      }
      const [[row]] = await pool.query(`SELECT * FROM surveys WHERE id = ?`, [surveyId])
      if (!row) return { ok: false, message: '问卷不存在' }

      const now = new Date()
      let windowStatus = '进行中'
      let windowMessage = null
      if (row.start_at) {
        const start = parseShanghaiDateTime(row.start_at)
        if (start && now < start) {
          windowStatus = '尚未开始'
          windowMessage = `开始时间 ${row.start_at}`
        }
      }
      if (windowStatus === '进行中' && row.end_at) {
        const end = parseShanghaiDateTime(row.end_at)
        if (end && now > end) {
          windowStatus = '已结束'
          windowMessage = `结束时间 ${row.end_at}`
        }
      }
      if (row.status === 'draft') windowStatus = '草稿'
      if (row.status === 'closed') windowStatus = '已关闭'

      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS c FROM survey_responses WHERE survey_id = ?`,
        [surveyId]
      )
      const responseCount = Number(countRow?.c || 0)
      const maxResp =
        row.max_responses != null && Number(row.max_responses) > 0
          ? Number(row.max_responses)
          : null

      let claimCount = null
      let submittedClaims = null
      if (row.is_anonymous) {
        const [[c]] = await pool.query(
          `SELECT COUNT(*) AS claimed,
                  SUM(submitted_at IS NOT NULL) AS submitted
           FROM survey_claims WHERE survey_id = ?`,
          [surveyId]
        )
        claimCount = Number(c?.claimed || 0)
        submittedClaims = Number(c?.submitted || 0)
      }

      let respondents = []
      if (!row.is_anonymous) {
        const [people] = await pool.query(
          `SELECT r.id AS response_id, r.member_id, m.nickname, m.qq, m.stage_role, r.submitted_at
           FROM survey_responses r
           LEFT JOIN members m ON m.id = r.member_id
           WHERE r.survey_id = ?
           ORDER BY r.submitted_at DESC
           LIMIT 80`,
          [surveyId]
        )
        respondents = people.map((p) => ({
          response_id: p.response_id,
          member_id: p.member_id,
          nickname: p.nickname || '(已退队或未知)',
          qq: p.qq || null,
          stage_role: p.stage_role || null,
          submitted_at: p.submitted_at,
        }))
      }

      let fields = []
      let subjects = []
      try {
        const templates = typeof row.fields_json === 'string'
          ? JSON.parse(row.fields_json || '[]')
          : row.fields_json || []
        subjects = typeof row.subjects_json === 'string'
          ? JSON.parse(row.subjects_json || '[]')
          : row.subjects_json || []
        fields =
          Array.isArray(subjects) && subjects.length
            ? expandSurveyFields(subjects, templates)
            : Array.isArray(templates)
              ? templates
              : []
      } catch {
        fields = []
        subjects = []
      }

      const [respRows] = await pool.query(
        `SELECT answers_json FROM survey_responses WHERE survey_id = ? ORDER BY id DESC LIMIT 500`,
        [surveyId]
      )
      const answersList = respRows.map((r) => {
        try {
          return typeof r.answers_json === 'string'
            ? JSON.parse(r.answers_json)
            : r.answers_json || {}
        } catch {
          return {}
        }
      })

      const isSatisfaction = Array.isArray(subjects) && subjects.length > 0
      let satisfaction = null
      if (isSatisfaction) {
        try {
          satisfaction = buildSatisfactionSummary(
            subjects,
            fields,
            answersList.map((answers) => ({ answers }))
          )
        } catch {
          satisfaction = null
        }
      }

      const fillRateHint =
        maxResp != null
          ? `${responseCount}/${maxResp}`
          : `${responseCount} 份（未设上限）`

      const built = buildSurveyAiSummary({
        title: row.title,
        windowStatus,
        windowMessage,
        status: row.status,
        isAnonymous: !!row.is_anonymous,
        fillRateHint,
        claimCount,
        submittedClaims,
        respondents,
        subjects,
        fields,
        answersList,
        satisfaction,
      })
      const summaryText = built.summary_text
      const ranked = Array.isArray(satisfaction)
        ? satisfaction.filter((s) => s.avg_score != null)
        : []

      return {
        ok: true,
        survey: {
          id: row.id,
          title: row.title,
          status: row.status,
          is_anonymous: !!row.is_anonymous,
          is_satisfaction: isSatisfaction,
          results_public: !!row.results_public,
          start_at: row.start_at,
          end_at: row.end_at,
          window_status: windowStatus,
          window_message: windowMessage,
        },
        fill: {
          response_count: responseCount,
          max_responses: maxResp,
          fill_progress: fillRateHint,
          claim_count: claimCount,
          submitted_claims: submittedClaims,
          respondent_count: respondents.length,
          subject_count: subjects.length || 0,
          text_answer_count: built.text_answer_count,
        },
        satisfaction_top: ranked.slice(0, 3),
        satisfaction_bottom: ranked.length > 3 ? ranked.slice(-3).reverse() : [],
        choice_summary: (built.choice_blocks || []).slice(0, 8),
        analysis_payload: built.analysis_payload,
        summary_text: summaryText,
        message: summaryText,
      }
    }

    case 'explain_how_to': {
      const topic = String(a.topic || '').toLowerCase()
      const guides = {
        overview: [
          '催促名单在侧栏「催促名单」：两个页签——训练催促、进度催促。',
          '训练催促：按上次训练起算的未训超时（新训为主；正式队员短周期开启时也走这里）。',
          '进度催促（原考勤催促）：升期时限、正式队员闲置再训等规则链，与训练催促不是同一套。',
          '规则总设置：催促名单页右上角「规则总设置」。',
        ],
        quit: [
          '改希望退队日：在对应页签勾选成员 →「批量设置退队」；或单行菜单改。',
          '也可直接对我说：「进度催促里除了紫夜，退队日统一改到 YYYY-MM-DD」。',
          '正式队员全局短周期天数：规则总设置 → 训练催促 →「正式队员考勤周期」；或对我说「正式队员全局改成 N 天」。',
        ],
        rules: [
          '修改预警天数、默认超时、进度规则链：催促名单 → 规则总设置。',
          '也可对我说：「把升到三期改成 40 天」「升到准考改成 50 天」「进度催促预警改成 10 天」「正式队员短周期改成 14 天」。',
        ],
        progress: [
          '进度催促管升到三期/准考、半年新训等；名单页签名现为「进度催促」。',
          '改某条升期时限直接说「升到三期改成 N 天」，我会改规则链 deadlineDays，不是改预警天数。',
          '不要和「训练催促」混淆；也不要和「正式队员考勤周期」（短周期倒计时）混淆。',
        ],
        training: [
          '训练催促管未训超时；自定义退队日会写入个人超时天数。',
          '正式队员若开启短周期，也会出现在训练催促并常驻倒计时。',
        ],
      }
      let keys = ['overview']
      if (/退队|quit|日期|统一/.test(topic)) keys = ['quit', 'overview']
      else if (/规则|设置|预警|超时/.test(topic)) keys = ['rules', 'overview']
      else if (/进度|升期|考勤催促|闲置/.test(topic)) keys = ['progress', 'quit']
      else if (/训练|未训/.test(topic)) keys = ['training', 'quit']
      else if (/正式|紫夜|尖兵/.test(topic)) keys = ['quit', 'training', 'progress']
      const lines = keys.flatMap((k) => guides[k] || [])
      return { ok: true, topic: a.topic, steps: lines }
    }

    case 'list_capabilities':
      return {
        ok: true,
        note:
          '以下能力已真实接入数据库。未接入：反作弊整块、表格文档编辑、意见箱、视频上传/报告公开细节、助教建档升期等复杂审批写入、批量重置密码；填表仅支持总结填写情况，不能改问卷。',
        naming: {
          progress_reminder: '进度催促（原考勤催促）',
          training_reminder: '训练催促',
        },
        read: [
          'summarize_activity',
          'search_members / get_member',
          'count_on_leave / rank_leave_days / list_leaves',
          'list_black_points',
          'get_today_checkin',
          'list_stale_members / list_training_reminders / list_progress_reminders',
          'get_reminder_rules / explain_how_to',
          'list_retention / list_quit_approvals / count_quit_pending',
          'list_assessment_applications / list_assessments',
          'list_courses / list_assistant_pending',
          'list_surveys / summarize_survey',
          'list_capabilities',
        ],
        write: [
          'create_leave / update_leave / delete_leave / end_leave',
          'add_black_point / delete_black_points / invalidate_black_point',
          'set_last_training_date / update_member / batch_update_members',
          'regenerate_checkin_code / stop_today_checkin',
          'batch_set_training_quit_date / batch_set_progress_quit_date',
          'update_reminder_rules',
          'create_quit_approval / review_quit_approvals / delete_quit_approvals',
          'create_retention / delete_retention',
          'review_assessment_applications / delete_assessment_applications',
          'batch_set_course_progress',
          'review_assistant_assignment',
        ],
      }

    default:
      return { error: `未知工具: ${name}` }
  }
}

function buildChatSystemMessage(today) {
  return {
    role: 'system',
    content:
      `你是「紫夜公会」管理端鲶鱼助手。今天（上海时区）是 ${today}。` +
      '你已接入：成员/请假/黑点/签到/催促规则/留队/退队审批/考核审批与记录/课程进度/助教带学员审批/填表总结。' +
      '反作弊板块、表格文档、意见箱、视频上传等未接入，直接说做不到。填表只能 list_surveys / summarize_survey，不能改问卷。' +
      '用户问你能干什么时，调用 list_capabilities；问怎么操作时，调用 explain_how_to。' +
      '硬性规则：' +
      '1) 任何写操作必须调用对应工具；只有工具返回 ok:true 才能说成功。做不到或工具失败时，直接说做不到/失败原因，禁止编造成功。' +
      '2) 提前结束/销假必须调用 end_leave；删除请假记录必须调用 delete_leave（禁止用 end_leave 冒充删除）；改请假日期/原因用 update_leave。' +
      '3) 请假 create_leave：相对日期必须传 until_offset_days（明天=1，后天=2），不要自己编错误年份；' +
      `今天是 ${today}，「到后天」应传 until_offset_days=2。` +
      '4) 黑点：登记用 add_black_point；用户说删除必须用 delete_black_points（真正 DELETE）；' +
      '撤销/失效用 invalidate_black_point（改为已失效）。禁止用失效冒充删除。' +
      '5) 改阶段/备注用 update_member；多人批量用 batch_update_members；查人用 search_members / get_member。' +
      '6) 催促：训练催促=list_training_reminders / batch_set_training_quit_date；' +
      '进度催促（原考勤催促）=list_progress_reminders / batch_set_progress_quit_date。' +
      '改进度规则链用 update_reminder_rules（rule_query + rule_deadline_days）。' +
      '7) 退队审批：list_quit_approvals / create_quit_approval / review_quit_approvals / delete_quit_approvals；' +
      '留队：list_retention / create_retention / delete_retention。' +
      '8) 考核审批（非反作弊）：list_assessment_applications / review_assessment_applications；' +
      '考核记录：list_assessments。课程：list_courses / batch_set_course_progress。' +
      '9) 助教：list_assistant_pending；仅带学员申请可 review_assistant_assignment。' +
      '10) 填表：list_surveys 列问卷；summarize_survey 拉取统计与开放题事实后，写分析性总结（归纳主题与建议，禁止只贴数字表）。' +
      '用户仍说「考勤催促」时按进度催促处理。回答简洁中文，引用工具真实字段。',
  }
}

function applyAntiHallucination(userMessage, finalText, toolTrace) {
  let text = finalText
  const writeTools = new Set([
    'create_leave',
    'update_leave',
    'delete_leave',
    'end_leave',
    'add_black_point',
    'invalidate_black_point',
    'delete_black_points',
    'set_last_training_date',
    'update_member',
    'batch_update_members',
    'regenerate_checkin_code',
    'stop_today_checkin',
    'batch_set_training_quit_date',
    'batch_set_progress_quit_date',
    'update_reminder_rules',
    'create_quit_approval',
    'review_quit_approvals',
    'delete_quit_approvals',
    'create_retention',
    'delete_retention',
    'review_assessment_applications',
    'delete_assessment_applications',
    'batch_set_course_progress',
    'review_assistant_assignment',
  ])
  const writeCalls = toolTrace.filter((t) => writeTools.has(t.name))
  const deleteLeaveIntent = /删除.*请假|删掉.*请假|去掉.*请假|移除.*请假/.test(userMessage)
  const endLeaveIntent =
    !deleteLeaveIntent && /结束.*请假|提前.*请假|销假|提前结束/.test(userMessage)
  const deleteLeaveOk = toolTrace.some((t) => t.name === 'delete_leave' && t.result?.ok === true)
  const deleteLeaveFail = toolTrace.find((t) => t.name === 'delete_leave' && t.result?.ok === false)
  const endLeaveOk = toolTrace.some((t) => t.name === 'end_leave' && t.result?.ok === true)
  const endLeaveFail = toolTrace.find((t) => t.name === 'end_leave' && t.result?.ok === false)
  const wronglyEnded =
    deleteLeaveIntent && toolTrace.some((t) => t.name === 'end_leave') && !deleteLeaveOk

  if (deleteLeaveIntent && !deleteLeaveOk) {
    if (wronglyEnded) {
      text =
        '删除请假未成功：本轮误用了 end_leave（结束/销假）。删除记录请再说「删除XXX的请假记录」，我会用 delete_leave。'
    } else if (deleteLeaveFail) {
      text = `删除请假未成功：${deleteLeaveFail.result.message || '未知原因'}`
    } else {
      text = '删除请假未成功：本轮没有真正调用 delete_leave。请再说「删除XXX的请假记录」。'
    }
  } else if (endLeaveIntent && !endLeaveOk) {
    if (endLeaveFail) {
      text = `结束请假未成功：${endLeaveFail.result.message || '未知原因'}`
    } else {
      text =
        '结束请假未成功：本轮没有真正调用 end_leave（或只改了成员状态）。' +
        '请再说一次「结束XXX的请假」，我必须用 end_leave 才会改请假记录。'
    }
  } else if (writeCalls.length) {
    const failed = writeCalls.filter((t) => t.result && t.result.ok === false)
    const succeeded = writeCalls.filter((t) => t.result && t.result.ok === true)
    if (succeeded.length) {
      text = succeeded.map((t) => t.result.message || JSON.stringify(t.result)).join('\n')
    } else if (failed.length) {
      text =
        `操作未成功：\n` +
        failed.map((t) => `- ${t.name}: ${t.result.message || JSON.stringify(t.result)}`).join('\n')
    }
  } else if (
    /已为|已登记|已添加|已结束|已删除|已更新|已修改|已保存|成功(?:地)?(?:完成|修改|更新|设置)/.test(text) &&
    /(请假|黑点|考勤|签到|结束|销假|删除|催促|退队|规则)/.test(userMessage)
  ) {
    text =
      '我做不到用空口承诺完成这项操作：本轮未调用写入工具。' +
      '请换一种明确说法；若该功能未接入，我会直接说做不到。'
  }
  return text
}

/** 把完整回复拆成适合逐段推送的小块（偏句 / 短语） */
function iterateReplyChunks(text) {
  const s = String(text || '')
  if (!s) return []
  const chunks = []
  const sentenceRe = /[^。！？\n]+[。！？]?|\n+/g
  let m
  while ((m = sentenceRe.exec(s))) {
    const sentence = m[0]
    if (sentence.length <= 18) {
      chunks.push(sentence)
      continue
    }
    for (let i = 0; i < sentence.length; i += 8) {
      chunks.push(sentence.slice(i, i + 8))
    }
  }
  if (!chunks.length) chunks.push(s)
  return chunks
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 基于问卷事实写分析性总结（无工具，避免空转） */
async function narrateSurveySummary(userMessage, surveyResult, onStatus) {
  onStatus?.('撰写分析总结…')
  const facts =
    surveyResult?.analysis_payload ||
    ({
      briefing: surveyResult?.summary_text || surveyResult?.message || '',
    })
  const messages = [
    {
      role: 'system',
      content:
        '你是紫夜公会管理端的问卷分析助手。用户要的是「总结」，不是把数据再贴一遍。' +
        '必须基于给定事实写作，禁止编造未出现的人名、分数、原话。' +
        '结构建议：' +
        '1) 一句话总览（回收情况 + 整体满意度水平）；' +
        '2) 均分解读：谁更突出、差距是否明显、哪些样本偏少需谨慎——用结论语气，不要逐行抄字段；' +
        '3) 开放题/建议：归纳 3～6 个主题（如节奏、作业、沟通、排课等），每主题用一两句概括，并可各引 1 条短原话；' +
        '4) 可执行改进建议 3～5 条；' +
        '5) 若几乎没有开放题，要明确说明「定性反馈不足」。' +
        '语气专业简洁，中文，约 400～900 字；可用小标题，不要输出 JSON。',
    },
    {
      role: 'user',
      content:
        `管理员原话：${String(userMessage || '').slice(0, 500)}\n\n` +
        `问卷事实如下，请据此写分析总结：\n${JSON.stringify(facts).slice(0, 14000)}`,
    },
  ]
  const data = await callZhipu(messages, null)
  const text = String(data?.choices?.[0]?.message?.content || '').trim()
  if (text) return text
  return (
    surveyResult?.summary_text ||
    surveyResult?.message ||
    '已取得问卷数据，但模型未写出总结。请重试。'
  )
}

async function executeAdminChat(req, userMessage, history, { onStatus } = {}) {
  const today = shanghaiToday()
  const system = buildChatSystemMessage(today)
  const messages = [
    system,
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    { role: 'user', content: userMessage.slice(0, 4000) },
  ]

  const toolTrace = []
  let rounds = 0
  let finalText = ''

  while (rounds < 6) {
    rounds += 1
    onStatus?.(rounds === 1 ? '思考中…' : `整理第 ${rounds} 轮结果…`)
    const data = await callZhipu(messages, TOOLS)
    const choice = data?.choices?.[0]?.message
    if (!choice) {
      finalText = '模型未返回有效内容'
      break
    }

    const toolCalls = choice.tool_calls || choice.tool_call
    const calls = Array.isArray(toolCalls) ? toolCalls : toolCalls ? [toolCalls] : []

    if (!calls.length) {
      finalText = String(choice.content || '').trim() || '（无文本回复）'
      break
    }

    const names = calls.map((c) => c.function?.name || c.name || 'tool').filter(Boolean)
    onStatus?.(names.length ? `执行工具：${names.join('、')}` : '执行工具…')

    messages.push({
      role: 'assistant',
      content: choice.content || null,
      tool_calls: calls,
    })

    for (const call of calls) {
      const fn = call.function || {}
      const name = fn.name
      let args = {}
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {}
      } catch {
        args = {}
      }
      let result
      try {
        result = await runTool(name, args, req)
      } catch (e) {
        result = { error: e.message || String(e) }
      }
      toolTrace.push({ name, args, result })
      const forModel =
        name === 'summarize_survey' && result?.ok
          ? {
              ok: true,
              fill: result.fill,
              survey: result.survey,
              has_analysis_payload: !!result.analysis_payload,
              open_feedback_count: result.fill?.text_answer_count ?? 0,
              tip: '问卷事实已就绪，系统将据此撰写分析总结，无需再调工具。',
            }
          : result
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${name}_${rounds}`,
        content: JSON.stringify(forModel).slice(0, 8000),
      })
    }

    const surveyDone = [...toolTrace]
      .reverse()
      .find((t) => t.name === 'summarize_survey' && t.result?.ok)
    if (surveyDone) {
      try {
        finalText = await narrateSurveySummary(userMessage, surveyDone.result, onStatus)
      } catch (e) {
        console.warn('[adminAi] narrateSurveySummary failed:', e.message)
        finalText =
          String(surveyDone.result.summary_text || surveyDone.result.message || '').trim() ||
          `问卷数据已取到，但撰写总结失败：${e.message || '未知错误'}`
      }
      onStatus?.('已生成问卷总结')
      break
    }
  }

  if (!finalText && toolTrace.length) {
    finalText = '已执行工具，但模型未给出最终文字说明。请查看工具结果。'
  }

  finalText = applyAntiHallucination(userMessage, finalText, toolTrace)
  return { finalText, toolTrace }
}

router.get('/status', requireAdmin, (_req, res) => {
  res.json({
    success: true,
    data: {
      configured: !!apiKey(),
      model: modelName(),
      model_chain: modelChain(),
      fallback_model: fallbackModelName(),
      active_model: activeModelName(),
      primary_cooldown_ms: getPrimaryCooldownMs(),
      provider: 'zhipu',
    },
  })
})

router.post('/chat', requireAdmin, async (req, res) => {
  try {
    if (!apiKey()) {
      return res.status(400).json({
        success: false,
        message: '请先在服务器 .env 配置 ZHIPU_API_KEY（智谱开放平台）',
        code: 'NO_KEY',
      })
    }

    const userMessage = String(req.body?.message || '').trim()
    if (!userMessage) {
      return res.status(400).json({ success: false, message: '请输入问题' })
    }

    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : []
    const { finalText, toolTrace } = await executeAdminChat(req, userMessage, history)

    res.json({
      success: true,
      data: {
        reply: finalText,
        tools: toolTrace,
        model: activeModelName(),
      },
    })
  } catch (e) {
    console.error('[adminAi] chat', e)
    res.status(500).json({
      success: false,
      message: e.message || 'AI 请求失败',
      code: e.code || 'AI_FAIL',
    })
  }
})

/** SSE 流式回复：工具跑完后按句/段推送正文 */
router.post('/chat-stream', requireAdmin, async (req, res) => {
  const send = (obj) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  try {
    if (!apiKey()) {
      res.status(400).json({
        success: false,
        message: '请先在服务器 .env 配置 ZHIPU_API_KEY（智谱开放平台）',
        code: 'NO_KEY',
      })
      return
    }

    const userMessage = String(req.body?.message || '').trim()
    if (!userMessage) {
      res.status(400).json({ success: false, message: '请输入问题' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : []
    send({ type: 'status', text: '思考中…' })

    const { finalText, toolTrace } = await executeAdminChat(req, userMessage, history, {
      onStatus: (text) => send({ type: 'status', text }),
    })

    send({ type: 'status', text: '' })
    for (const chunk of iterateReplyChunks(finalText)) {
      send({ type: 'delta', text: chunk })
      await sleep(22)
    }
    send({ type: 'done', tools: toolTrace, model: activeModelName(), reply: finalText })
    res.end()
  } catch (e) {
    console.error('[adminAi] chat-stream', e)
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: e.message || 'AI 请求失败',
        code: e.code || 'AI_FAIL',
      })
      return
    }
    send({ type: 'error', message: e.message || 'AI 请求失败' })
    res.end()
  }
})

/** 一键活跃度总结：数据未变读缓存；签到变化或 ?refresh=1 时重新生成并覆盖 */
router.get('/activity-report', requireAdmin, async (req, res) => {
  try {
    const days = Number(req.query.days) || 14
    const forceRefresh =
      req.query.refresh === '1' ||
      req.query.refresh === 'true' ||
      req.query.force === '1' ||
      req.query.force === 'true'

    const summary = await buildActivitySummary({ days })
    const fingerprint = activityFingerprint(summary)

    if (!forceRefresh) {
      const cached = await readStoredActivityReport()
      if (cached?.narrative && cached.fingerprint === fingerprint) {
        return res.json({
          success: true,
          data: {
            summary: cached.summary || summary,
            narrative: cached.narrative,
            updated_at: cached.updated_at || null,
            from_cache: true,
            model: cached.model || null,
          },
        })
      }
    }

    let narrative = ''
    if (!apiKey()) {
      const suspectBit = summary.ip_change_suspect_names?.length
        ? `网络环境变化需核实：${summary.ip_change_suspect_names.join('、')}。`
        : ''
      const proxyBit = summary.proxy_member_names?.length
        ? `已登记代签：${summary.proxy_member_names.join('、')}。`
        : ''
      narrative =
        `近 ${summary.window_days} 天签到：共 ${summary.checkin_total} 人次、` +
        `${summary.checkin_unique_members} 人到场，有签到记录的天数 ${summary.checkin_days_with_records}/` +
        `${summary.window_days}，日均约 ${summary.checkin_avg_per_active_day} 人。` +
        (summary.today_checkin
          ? `今日已签 ${summary.today_checkin.checked_count} 人。`
          : '今日尚无签到任务。') +
        suspectBit +
        proxyBit +
        '（未配置 ZHIPU_API_KEY，以上为签到汇总）'
    } else {
      const data = await callZhipu(
        [
          {
            role: 'system',
            content:
              '你是公会「签到活跃度」分析助手。活跃度只看签到参与。' +
              '硬性要求：' +
              '1) 若 ip_change_suspect_names / ip_change_suspects 非空，必须用真实昵称点名（如「某某相邻两天网络不一致，疑似代签或换设备」），禁止只说「有人/部分成员」。' +
              '2) 若 proxy_member_names / proxy_checkins 非空，必须点名谁被代签（可带代签人 proxy_name）。' +
              '3) 绝对不要写出任何具体 IP 或网段。' +
              '4) 字段少就自由总结；不超过 200 字，不要用项目符号列表。',
          },
          { role: 'user', content: JSON.stringify(summary) },
        ],
        undefined
      )
      narrative = data?.choices?.[0]?.message?.content || ''
    }

    const payload = {
      narrative,
      summary,
      days,
      fingerprint,
      updated_at: new Date().toISOString(),
      model: activeModelName(),
    }
    await writeStoredActivityReport(payload)

    res.json({
      success: true,
      data: {
        summary,
        narrative,
        updated_at: payload.updated_at,
        from_cache: false,
        model: payload.model,
      },
    })
  } catch (e) {
    console.error('[adminAi] activity-report', e)
    res.status(500).json({ success: false, message: e.message || '生成报告失败' })
  }
})

/**
 * 单张问卷结果页 AI 总结。
 * 有缓存且答卷指纹未变则直接返回；不支持手动 refresh。
 */
router.get('/survey-report', requireAdmin, async (req, res) => {
  try {
    const surveyId = Number(req.query.survey_id)
    if (!Number.isFinite(surveyId) || surveyId <= 0) {
      return res.status(400).json({ success: false, message: '缺少 survey_id' })
    }

    const facts = await buildSingleSurveyReportFacts(surveyId)
    if (!facts) {
      return res.status(404).json({ success: false, message: '问卷不存在' })
    }
    const fingerprint = surveyReportFingerprint(facts)

    const cached = await readStoredSurveyReport(surveyId)
    if (cached?.narrative && cached.fingerprint === fingerprint) {
      return res.json({
        success: true,
        data: {
          facts: cached.facts || facts,
          narrative: cached.narrative,
          updated_at: cached.updated_at || null,
          from_cache: true,
          model: cached.model || null,
        },
      })
    }

    let narrative = ''
    if (facts.response_count <= 0) {
      narrative = `「${facts.title}」尚无答卷，暂无可分析内容。有人提交后再次进入结果页会自动生成总结。`
    } else if (!apiKey()) {
      narrative =
        (facts.briefing || `「${facts.title}」已收 ${facts.response_count} 份答卷。`) +
        '\n（未配置 ZHIPU_API_KEY，以上为数据摘要）'
    } else {
      const data = await callZhipu(
        [
          {
            role: 'system',
            content:
              '你是紫夜公会问卷结果页的分析助手。用户要的是「总结」，不是把数据再贴一遍。' +
              '必须基于给定事实，禁止编造未出现的人名、分数、原话。' +
              '结构建议：一句话总览；均分/选项解读；开放题主题归纳（可引短原话）；3～5 条可执行建议。' +
              '中文，可用小标题，约 400～900 字。',
          },
          {
            role: 'user',
            content:
              `请总结问卷「${facts.title}」的结果：\n` +
              JSON.stringify(facts.analysis_payload || { briefing: facts.briefing }).slice(0, 14000),
          },
        ],
        null
      )
      narrative = String(data?.choices?.[0]?.message?.content || '').trim()
      if (!narrative) {
        narrative = facts.briefing || `「${facts.title}」已有 ${facts.response_count} 份答卷，模型未返回正文。`
      }
    }

    const payload = {
      narrative,
      facts,
      fingerprint,
      updated_at: new Date().toISOString(),
      model: activeModelName(),
    }
    await writeStoredSurveyReport(surveyId, payload)

    res.json({
      success: true,
      data: {
        facts,
        narrative,
        updated_at: payload.updated_at,
        from_cache: false,
        model: payload.model,
      },
    })
  } catch (e) {
    console.error('[adminAi] survey-report', e)
    res.status(500).json({ success: false, message: e.message || '生成问卷总结失败' })
  }
})

export default router
