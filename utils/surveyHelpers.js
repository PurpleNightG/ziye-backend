/** 满意度调查问卷：按人展开 / 门禁隐藏 / 计分 */

export const ATTENDED = '上过'
export const NOT_ATTENDED = '我没有上过这个教官的课'

export function parseJsonField(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** 从「很满意(5)」或纯数字提取分数 */
export function extractScoreValue(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const s = String(raw)
  const paren = s.match(/\((\d+(?:\.\d+)?)\)/)
  if (paren) return Number(paren[1])
  const num = s.match(/^(\d+(?:\.\d+)?)$/)
  if (num) return Number(num[1])
  // 常见中文量表兜底
  if (s.includes('很满意')) return 5
  if (s.includes('满意') && !s.includes('不')) return 4
  if (s.includes('一般')) return 3
  if (s.includes('很不满意')) return 1
  if (s.includes('不满意')) return 2
  return null
}

export function isFieldVisible(field, answers) {
  if (!field?.gate_field_id) return true
  const gate = answers?.[field.gate_field_id]
  if (!gate) return false
  if (field.hide_when_gate && gate === field.hide_when_gate) return false
  return true
}

/**
 * 若有评价对象 subjects，将「按人」模板题按人展开；scope=global 的题目保持全局不展开。
 * subjects: [{ id, name, member_id? }]
 * fields: 题目模板（不含 subject_gate）
 */
export function expandSurveyFields(subjects, templates) {
  const subs = Array.isArray(subjects) ? subjects : []
  const tpls = Array.isArray(templates) ? templates.filter((f) => f.type !== 'subject_gate') : []
  if (!subs.length) return tpls

  const perSubject = tpls.filter((t) => t.scope !== 'global')
  const globalOnes = tpls.filter((t) => t.scope === 'global')

  const fields = []
  for (const sub of subs) {
    const gateId = `gate__${sub.id}`
    fields.push({
      id: gateId,
      type: 'subject_gate',
      subject_id: sub.id,
      subject_name: sub.name,
      label: '您是否上过该教官的课？',
      options: [ATTENDED, NOT_ATTENDED],
      required: true,
    })
    for (const t of perSubject) {
      fields.push({
        ...JSON.parse(JSON.stringify(t)),
        id: `${t.id}__${sub.id}`,
        template_id: t.id,
        subject_id: sub.id,
        subject_name: sub.name,
        // 题干不拼人名，前端用标签展示
        label: t.label,
        gate_field_id: gateId,
        hide_when_gate: NOT_ATTENDED,
        scope: 'subject',
      })
    }
  }
  for (const t of globalOnes) {
    fields.push({
      ...JSON.parse(JSON.stringify(t)),
      scope: 'global',
      subject_id: null,
      subject_name: null,
    })
  }
  return fields
}

export function validateAnswers(fields, answers) {
  if (!answers || typeof answers !== 'object') {
    return '答案格式无效'
  }
  for (const field of fields) {
    if (!isFieldVisible(field, answers)) continue

    const val = answers[field.id]

    if (field.type === 'subject_gate' || field.type === 'single') {
      if (field.required && (val == null || val === '')) {
        return `请填写：${field.label}`
      }
      if (val != null && val !== '' && typeof val !== 'string') {
        return `单选题格式错误：${field.label}`
      }
      continue
    }

    if (field.type === 'matrix') {
      const map = val && typeof val === 'object' && !Array.isArray(val) ? val : {}
      const rows = Array.isArray(field.rows) ? field.rows : []
      const cols = Array.isArray(field.columns) ? field.columns : []
      if (field.required) {
        for (const row of rows) {
          if (!map[row.id]) return `请完成：${field.label}`
        }
      }
      for (const [rowId, col] of Object.entries(map)) {
        if (cols.length && !cols.includes(col)) return `矩阵题选项无效：${field.label}`
        if (rows.length && !rows.some((r) => r.id === rowId)) return `矩阵题行无效：${field.label}`
      }
      continue
    }

    if (field.required) {
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
        return `请填写：${field.label}`
      }
    }
    if (val == null || val === '') continue
    if (field.type === 'multi' && !Array.isArray(val)) return `多选题格式错误：${field.label}`
    if ((field.type === 'text' || field.type === 'textarea') && typeof val !== 'string') {
      return `文本题格式错误：${field.label}`
    }
    if (field.type === 'rating') {
      const n = Number(val)
      const max = Number(field.maxRating) || 5
      if (!Number.isFinite(n) || n < 1 || n > max) return `评分超出范围：${field.label}`
    }
  }
  return null
}

/** 收集一份答卷中某评价对象的所有可计分分数 */
function scoresFromResponseForSubject(fields, answers, subjectId) {
  const scores = []
  for (const field of fields) {
    if (field.subject_id !== subjectId) continue
    if (field.type === 'subject_gate') continue
    if (!isFieldVisible(field, answers)) continue
    const val = answers[field.id]
    if (val == null || val === '') continue

    if (field.type === 'matrix' && typeof val === 'object' && !Array.isArray(val)) {
      for (const col of Object.values(val)) {
        const s = extractScoreValue(col)
        if (s != null) scores.push(s)
      }
    } else if (field.type === 'rating' || field.type === 'single') {
      const s = extractScoreValue(val)
      if (s != null) scores.push(s)
    }
  }
  return scores
}

/**
 * 按人汇总满意度
 * 返回每人：均分、样本数(上过并打过分)、未上课次数、样本可信度提示
 */
export function buildSatisfactionSummary(subjects, fields, responses) {
  const list = []
  for (const sub of subjects || []) {
    let attended = 0
    let notAttended = 0
    let scoredResponses = 0
    const allScores = []

    for (const resp of responses || []) {
      const answers = resp.answers || {}
      const gateId = `gate__${sub.id}`
      const gate = answers[gateId]
      if (gate === NOT_ATTENDED) {
        notAttended += 1
        continue
      }
      if (gate === ATTENDED) {
        attended += 1
        const scores = scoresFromResponseForSubject(fields, answers, sub.id)
        if (scores.length) {
          scoredResponses += 1
          allScores.push(...scores)
        }
      }
    }

    const avg =
      allScores.length > 0
        ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 100) / 100
        : null

    let reliability = 'none'
    if (scoredResponses >= 5) reliability = 'good'
    else if (scoredResponses >= 3) reliability = 'ok'
    else if (scoredResponses >= 1) reliability = 'low'
    // n=1 满分会被标 low，前端显著提示

    list.push({
      subject_id: sub.id,
      name: sub.name,
      member_id: sub.member_id ?? null,
      attended,
      not_attended: notAttended,
      sample_size: scoredResponses,
      score_points: allScores.length,
      avg_score: avg,
      reliability,
      reliability_note:
        scoredResponses === 0
          ? '尚无有效评分'
          : scoredResponses === 1
            ? '仅 1 人评过分，均分极易受单人影响，不可直接当作整体口碑'
            : scoredResponses < 3
              ? `样本仅 ${scoredResponses} 人，参考意义有限`
              : null,
    })
  }

  // 有均分的按均分排序；无均分垫底
  list.sort((a, b) => {
    if (a.avg_score == null && b.avg_score == null) return 0
    if (a.avg_score == null) return 1
    if (b.avg_score == null) return -1
    return b.avg_score - a.avg_score
  })

  return list
}

function bumpCount(map, key, n = 1) {
  if (!key) return
  map[key] = (map[key] || 0) + n
}

function topEntries(map, limit = 6) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }))
}

function formatTop(top, limit = 5) {
  return (top || [])
    .slice(0, limit)
    .map((t) => `${t.label}×${t.count}`)
    .join('，')
}

function trimAnswerText(raw, maxLen = 220) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}

/**
 * 管理端 AI 问卷总结文案：覆盖均分、选项分布、开放题/建议原文
 */
export function buildSurveyAiSummary({
  title,
  windowStatus,
  windowMessage,
  status,
  isAnonymous,
  fillRateHint,
  claimCount = null,
  submittedClaims = null,
  respondents = [],
  subjects = [],
  fields = [],
  answersList = [],
  satisfaction = null,
}) {
  const isSatisfaction = Array.isArray(subjects) && subjects.length > 0
  const lines = [
    `【${title}】填写情况总结`,
    `状态：${windowStatus}${windowMessage ? `（${windowMessage}）` : ''}；发布状态 ${status}`,
    `答卷：${fillRateHint}` +
      (isAnonymous
        ? `；匿名领取 ${claimCount ?? 0}，已提交 ${submittedClaims ?? 0}`
        : `；实名已填 ${respondents.length} 人`),
  ]

  const ranked = Array.isArray(satisfaction)
    ? satisfaction.filter((s) => s.avg_score != null)
    : []

  if (isSatisfaction) {
    lines.push('')
    lines.push('一、满意度均分（全员）')
    lines.push(`评价对象 ${subjects.length} 人；有均分 ${ranked.length} 人`)
    const all = Array.isArray(satisfaction) ? satisfaction : []
    if (!all.length) {
      lines.push('暂无有效评分。')
    } else {
      all.forEach((s, i) => {
        const avg = s.avg_score != null ? Number(s.avg_score).toFixed(2) : '—'
        lines.push(
          `${i + 1}. ${s.name} 均分 ${avg}` +
            `（上过 ${s.attended ?? 0} / 未上过 ${s.not_attended ?? 0}；有效评分 ${s.sample_size ?? 0} 人）` +
            (s.reliability_note ? `；${s.reliability_note}` : '')
        )
      })
    }
  }

  // 选项/评分/矩阵：全局题逐题；按人题按「题目标签」汇总（避免每人×每题爆炸）
  const choiceBlocks = []
  const globalChoiceFields = fields.filter(
    (f) =>
      f.scope === 'global' &&
      ['single', 'multi', 'rating', 'matrix'].includes(f.type)
  )
  const subjectChoiceTemplates = new Map()
  for (const f of fields) {
    if (f.scope === 'global' || f.type === 'subject_gate') continue
    if (!['single', 'multi', 'rating', 'matrix'].includes(f.type)) continue
    const tid = f.template_id || f.id
    if (!subjectChoiceTemplates.has(tid)) {
      subjectChoiceTemplates.set(tid, { label: f.label, type: f.type, fields: [] })
    }
    subjectChoiceTemplates.get(tid).fields.push(f)
  }

  for (const field of globalChoiceFields.slice(0, 20)) {
    const counts = {}
    const rowLabels = Object.fromEntries((field.rows || []).map((r) => [r.id, r.label || r.id]))
    for (const ans of answersList) {
      const val = ans?.[field.id]
      if (val == null || val === '') continue
      if (field.type === 'matrix' && typeof val === 'object' && !Array.isArray(val)) {
        for (const [rowId, col] of Object.entries(val)) {
          bumpCount(counts, `${rowLabels[rowId] || rowId} · ${col}`)
        }
      } else if (Array.isArray(val)) {
        for (const v of val) bumpCount(counts, String(v))
      } else {
        bumpCount(counts, String(val))
      }
    }
    const top = topEntries(counts, 8)
    if (top.length) {
      choiceBlocks.push({ title: `全局 · ${field.label}`, top })
    }
  }

  for (const [, tpl] of [...subjectChoiceTemplates.entries()].slice(0, 12)) {
    if (tpl.type === 'rating') {
      const perSubject = []
      for (const field of tpl.fields) {
        const nums = []
        for (const ans of answersList) {
          if (!isFieldVisible(field, ans)) continue
          const s = extractScoreValue(ans?.[field.id])
          if (s != null) nums.push(s)
        }
        if (!nums.length) continue
        const avg = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
        perSubject.push({
          name: field.subject_name || '未知',
          avg,
          n: nums.length,
        })
      }
      perSubject.sort((a, b) => b.avg - a.avg)
      if (perSubject.length) {
        choiceBlocks.push({
          title: `按人评分 · ${tpl.label}`,
          line: perSubject
            .map((p) => `${p.name} ${p.avg.toFixed(2)}(n=${p.n})`)
            .join('；'),
        })
      }
      continue
    }

    const counts = {}
    for (const field of tpl.fields) {
      const rowLabels = Object.fromEntries((field.rows || []).map((r) => [r.id, r.label || r.id]))
      for (const ans of answersList) {
        if (!isFieldVisible(field, ans)) continue
        const val = ans?.[field.id]
        if (val == null || val === '') continue
        const prefix = field.subject_name ? `${field.subject_name}·` : ''
        if (field.type === 'matrix' && typeof val === 'object' && !Array.isArray(val)) {
          for (const [rowId, col] of Object.entries(val)) {
            bumpCount(counts, `${prefix}${rowLabels[rowId] || rowId} · ${col}`)
          }
        } else if (Array.isArray(val)) {
          for (const v of val) bumpCount(counts, `${prefix}${v}`)
        } else {
          bumpCount(counts, `${prefix}${val}`)
        }
      }
    }
    const top = topEntries(counts, 10)
    if (top.length) {
      choiceBlocks.push({ title: `按人 · ${tpl.label}`, top })
    }
  }

  // 非满意度普通问卷：直接扫前若干题
  if (!isSatisfaction && !choiceBlocks.length) {
    for (const field of fields.slice(0, 16)) {
      if (!['single', 'multi', 'rating', 'matrix', 'subject_gate'].includes(field.type)) continue
      const counts = {}
      const rowLabels = Object.fromEntries((field.rows || []).map((r) => [r.id, r.label || r.id]))
      for (const ans of answersList) {
        const val = ans?.[field.id]
        if (val == null || val === '') continue
        if (field.type === 'matrix' && typeof val === 'object' && !Array.isArray(val)) {
          for (const [rowId, col] of Object.entries(val)) {
            bumpCount(counts, `${rowLabels[rowId] || rowId} · ${col}`)
          }
        } else if (Array.isArray(val)) {
          for (const v of val) bumpCount(counts, String(v))
        } else {
          bumpCount(counts, String(val))
        }
      }
      const top = topEntries(counts, 6)
      if (top.length) {
        choiceBlocks.push({
          title: field.subject_name ? `${field.subject_name} · ${field.label}` : field.label,
          top,
        })
      }
    }
  }

  if (choiceBlocks.length) {
    lines.push('')
    lines.push(isSatisfaction ? '二、其他题目分布' : '一、选项/评分分布')
    for (const block of choiceBlocks.slice(0, 16)) {
      if (block.line) {
        lines.push(`- ${block.title}：${block.line}`)
      } else {
        lines.push(`- ${block.title}：${formatTop(block.top) || '无'}`)
      }
    }
  }

  // 开放题 / 建议：按「题目标签 + 对象」分组，保留原文
  const textGroups = new Map()
  for (const field of fields) {
    if (field.type !== 'text' && field.type !== 'textarea') continue
    const groupKey = `${field.template_id || field.id}::${field.subject_id || 'global'}`
    if (!textGroups.has(groupKey)) {
      const title =
        field.scope === 'global' || !field.subject_name
          ? `全局 · ${field.label}`
          : `对 ${field.subject_name} · ${field.label}`
      textGroups.set(groupKey, { title, samples: [] })
    }
    const group = textGroups.get(groupKey)
    for (const ans of answersList) {
      if (!isFieldVisible(field, ans)) continue
      const text = trimAnswerText(ans?.[field.id])
      if (!text) continue
      group.samples.push(text)
    }
  }

  const textSections = [...textGroups.values()]
    .map((g) => {
      const freq = {}
      for (const s of g.samples) bumpCount(freq, s)
      const uniq = topEntries(freq, 20).map((t) =>
        t.count > 1 ? `${t.label}（×${t.count}）` : t.label
      )
      return { title: g.title, items: uniq, total: g.samples.length }
    })
    .filter((g) => g.items.length)
    .sort((a, b) => {
      // 建议/意见类靠前
      const score = (t) => (/建议|意见|反馈|想说|补充|其他/.test(t) ? 0 : 1)
      return score(a.title) - score(b.title) || b.total - a.total
    })

  if (textSections.length) {
    lines.push('')
    lines.push(isSatisfaction ? '三、开放题与建议（原文摘录）' : '二、开放题（原文摘录）')
    let budget = 60
    for (const sec of textSections.slice(0, 20)) {
      if (budget <= 0) {
        lines.push('（其余开放题过多，已省略）')
        break
      }
      const take = Math.min(sec.items.length, Math.max(3, Math.min(12, budget)))
      lines.push(`【${sec.title}】共 ${sec.total} 条，摘录 ${take} 条：`)
      sec.items.slice(0, take).forEach((t, i) => {
        lines.push(`${i + 1}. ${t}`)
      })
      budget -= take
    }
  } else {
    lines.push('')
    lines.push(isSatisfaction ? '三、开放题与建议' : '二、开放题')
    lines.push('暂无文本类回答（或题目中未设置建议/开放题）。')
  }

  if (!isAnonymous && respondents.length) {
    lines.push('')
    lines.push(isSatisfaction ? '四、填写者' : '三、填写者')
    lines.push(
      respondents
        .slice(0, 20)
        .map((r) => r.nickname)
        .join('、') + (respondents.length > 20 ? ' …' : '')
    )
  }

  return {
    summary_text: lines.join('\n'),
    analysis_payload: {
      meta: {
        title,
        window_status: windowStatus,
        window_message: windowMessage || null,
        status,
        is_anonymous: !!isAnonymous,
        fill: fillRateHint,
        claim_count: claimCount,
        submitted_claims: submittedClaims,
        respondent_count: respondents.length,
        subject_count: subjects.length || 0,
      },
      satisfaction_ranking: (Array.isArray(satisfaction) ? satisfaction : []).map((s) => ({
        name: s.name,
        avg_score: s.avg_score,
        attended: s.attended,
        not_attended: s.not_attended,
        sample_size: s.sample_size,
        note: s.reliability_note || null,
      })),
      question_distributions: choiceBlocks.slice(0, 16).map((b) =>
        b.line
          ? { title: b.title, summary: b.line }
          : { title: b.title, top: (b.top || []).slice(0, 8) }
      ),
      open_ended_feedback: textSections.slice(0, 20).map((s) => ({
        title: s.title,
        total: s.total,
        samples: s.items.slice(0, 15),
      })),
    },
    choice_blocks: choiceBlocks.slice(0, 16),
    text_section_count: textSections.length,
    text_answer_count: textSections.reduce((n, s) => n + s.total, 0),
  }
}
