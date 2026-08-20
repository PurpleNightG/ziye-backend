import express from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { pool } from '../config/database.js'
import {
  parseJsonField,
  expandSurveyFields,
  validateAnswers,
  buildSatisfactionSummary,
} from '../utils/surveyHelpers.js'
import { requireAdmin, requireStudent } from '../utils/authGate.js'
import { parseShanghaiDateTime } from '../utils/date.js'

const router = express.Router()

let tablesReady = false

async function ensureSurveyTables() {
  if (tablesReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS surveys (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(200) NOT NULL COMMENT '标题',
      description TEXT NULL COMMENT '说明',
      fields_json JSON NOT NULL COMMENT '题目定义',
      subjects_json JSON NULL COMMENT '满意度评价对象',
      is_anonymous TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否匿名',
      start_at DATETIME NULL COMMENT '开始时间',
      end_at DATETIME NULL COMMENT '结束时间',
      max_responses INT NULL COMMENT '填写人数上限，NULL为不限制',
      status ENUM('draft','published','closed') NOT NULL DEFAULT 'draft' COMMENT '状态',
      audience_roles_json JSON NULL COMMENT '可填阶段角色，空=全体',
      created_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_survey_status (status),
      INDEX idx_survey_time (start_at, end_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='填表/调查问卷'
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_claims (
      id INT PRIMARY KEY AUTO_INCREMENT,
      survey_id INT NOT NULL,
      member_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME NULL,
      UNIQUE KEY uk_survey_member (survey_id, member_id),
      UNIQUE KEY uk_token_hash (token_hash),
      INDEX idx_survey_claim (survey_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='匿名填表领取凭证'
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_responses (
      id INT PRIMARY KEY AUTO_INCREMENT,
      survey_id INT NOT NULL,
      answers_json JSON NOT NULL,
      member_id INT NULL COMMENT '实名时填写，匿名必须为空',
      token_hash VARCHAR(64) NULL COMMENT '匿名防重复，管理端不展示',
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_survey_resp (survey_id),
      UNIQUE KEY uk_survey_member_resp (survey_id, member_id),
      UNIQUE KEY uk_survey_token_resp (survey_id, token_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='填表答卷'
  `)
  try {
    await pool.query(`
      ALTER TABLE surveys
      ADD COLUMN subjects_json JSON NULL COMMENT '满意度评价对象' AFTER fields_json
    `)
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }
  try {
    await pool.query(`
      ALTER TABLE surveys
      ADD COLUMN max_responses INT NULL COMMENT '填写人数上限，NULL为不限制' AFTER end_at
    `)
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }
  try {
    await pool.query(`
      ALTER TABLE surveys
      ADD COLUMN results_public TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否允许学员公开查看结果' AFTER max_responses
    `)
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }
  tablesReady = true
}

router.use(async (req, res, next) => {
  try {
    await ensureSurveyTables()
    next()
  } catch (e) {
    console.error('[surveys] ensure tables', e)
    res.status(500).json({ success: false, message: '数据库初始化失败' })
  }
})

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function normalizeSurvey(row) {
  if (!row) return null
  const subjects = parseJsonField(row.subjects_json, [])
  const templates = parseJsonField(row.fields_json, [])
  const expanded = expandSurveyFields(subjects, templates)
  return {
    ...row,
    fields: templates,
    subjects: Array.isArray(subjects) ? subjects : [],
    expanded_fields: expanded,
    is_satisfaction: Array.isArray(subjects) && subjects.length > 0,
    audience_roles: parseJsonField(row.audience_roles_json, []),
    is_anonymous: !!row.is_anonymous,
  }
}

const FULL_MESSAGE = '此表格填写人数已达上限'

function isWithinWindow(survey, now = new Date()) {
  if (survey.start_at) {
    const start = parseShanghaiDateTime(survey.start_at)
    if (start && now < start) return { ok: false, message: '填表尚未开始' }
  }
  if (survey.end_at) {
    const end = parseShanghaiDateTime(survey.end_at)
    if (end && now > end) return { ok: false, message: '填表已结束' }
  }
  return { ok: true }
}

function parseMaxResponses(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

async function getResponseCount(db, surveyId) {
  const [rows] = await db.query(
    'SELECT COUNT(*) AS c FROM survey_responses WHERE survey_id = ?',
    [surveyId]
  )
  return Number(rows[0]?.c || 0)
}

/** 是否仍有空位；max 为 null 表示不限制 */
async function checkCapacity(db, survey) {
  const max = parseMaxResponses(survey.max_responses)
  if (max == null) return { ok: true, max: null, count: null }
  const count = await getResponseCount(db, survey.id)
  if (count >= max) {
    return { ok: false, message: FULL_MESSAGE, max, count }
  }
  return { ok: true, max, count }
}

async function closeSurveyIfFull(db, surveyId, max) {
  if (max == null) return false
  const count = await getResponseCount(db, surveyId)
  if (count < max) return false
  await db.query(
    `UPDATE surveys SET status = 'closed' WHERE id = ? AND status = 'published'`,
    [surveyId]
  )
  return true
}

function roleAllowed(survey, stageRole) {
  const roles = parseJsonField(survey.audience_roles_json, [])
  if (!Array.isArray(roles) || roles.length === 0) return true
  return roles.includes(stageRole)
}

function activeFields(survey) {
  return survey.is_satisfaction ? survey.expanded_fields : survey.fields
}

// ─── 学员：可填列表 ───────────────────────────────────────

router.get('/available', requireStudent, async (req, res) => {
  try {
    const memberId = req.student.id
    const [[member]] = await pool.query(
      'SELECT id, nickname, stage_role FROM members WHERE id = ?',
      [memberId]
    )
    if (!member) return res.status(404).json({ success: false, message: '成员不存在' })

    const [rows] = await pool.query(`
      SELECT id, title, description, fields_json, subjects_json, is_anonymous, start_at, end_at,
             max_responses, results_public, status, audience_roles_json, created_at
      FROM surveys
      WHERE status = 'published'
         OR (
           status = 'closed'
           AND max_responses IS NOT NULL
           AND max_responses > 0
           AND (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = surveys.id) >= max_responses
         )
         OR (results_public = 1 AND status IN ('published', 'closed'))
      ORDER BY created_at DESC
    `)

    const now = new Date()
    const list = []
    for (const row of rows) {
      if (!roleAllowed(row, member.stage_role)) continue
      const window = isWithinWindow(row, now)
      const survey = normalizeSurvey(row)
      const capacity = await checkCapacity(pool, row)

      let myStatus = 'open'
      let windowMessage = window.ok ? null : window.message
      if (!capacity.ok) {
        myStatus = 'full'
        windowMessage = FULL_MESSAGE
      } else if (row.status === 'closed') {
        myStatus = 'ended'
        windowMessage = '填表已关闭'
      } else if (!window.ok) {
        myStatus = window.message.includes('尚未') ? 'not_started' : 'ended'
      }

      if (survey.is_anonymous) {
        const [claims] = await pool.query(
          'SELECT submitted_at FROM survey_claims WHERE survey_id = ? AND member_id = ?',
          [survey.id, memberId]
        )
        if (claims.length && claims[0].submitted_at) myStatus = 'submitted'
        else if (claims.length) myStatus = myStatus === 'open' ? 'claimed' : myStatus
      } else {
        const [resp] = await pool.query(
          'SELECT id FROM survey_responses WHERE survey_id = ? AND member_id = ?',
          [survey.id, memberId]
        )
        if (resp.length) myStatus = 'submitted'
      }

      list.push({
        id: survey.id,
        title: survey.title,
        description: survey.description,
        is_anonymous: survey.is_anonymous,
        start_at: survey.start_at,
        end_at: survey.end_at,
        max_responses: capacity.max,
        response_count: capacity.count,
        results_public: !!row.results_public,
        my_status: myStatus,
        field_count: Array.isArray(activeFields(survey)) ? activeFields(survey).length : 0,
        is_satisfaction: survey.is_satisfaction,
        subject_count: survey.subjects?.length || 0,
        window_ok: window.ok && capacity.ok && row.status === 'published',
        window_message: windowMessage,
      })
    }

    res.json({ success: true, data: list })
  } catch (error) {
    console.error('[surveys] available', error)
    res.status(500).json({ success: false, message: '获取问卷列表失败' })
  }
})

router.get('/available/:id', requireStudent, async (req, res) => {
  try {
    const memberId = req.student.id
    const [[member]] = await pool.query(
      'SELECT id, stage_role FROM members WHERE id = ?',
      [memberId]
    )
    if (!member) return res.status(404).json({ success: false, message: '成员不存在' })

    const [[row]] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id])
    if (!row) {
      return res.status(404).json({ success: false, message: '问卷不存在或未发布' })
    }
    if (!roleAllowed(row, member.stage_role)) {
      return res.status(403).json({ success: false, message: '不在投放范围内' })
    }

    const capacity = await checkCapacity(pool, row)
    const closedDueToFull =
      row.status === 'closed' && parseMaxResponses(row.max_responses) != null && !capacity.ok
    const canViewPublicClosed = row.status === 'closed' && !!row.results_public

    if (row.status !== 'published' && !closedDueToFull && !canViewPublicClosed) {
      return res.status(404).json({ success: false, message: '问卷不存在或未发布' })
    }

    const survey = normalizeSurvey(row)
    const window = isWithinWindow(row)
    let myStatus = window.ok ? 'open' : (window.message.includes('尚未') ? 'not_started' : 'ended')
    let windowMessage = window.ok ? null : window.message
    if (closedDueToFull || (myStatus === 'open' && !capacity.ok)) {
      myStatus = 'full'
      windowMessage = FULL_MESSAGE
    } else if (row.status === 'closed' && myStatus === 'open') {
      myStatus = 'ended'
      windowMessage = '填表已关闭'
    }
    let claimed = false
    let submitted = false

    if (survey.is_anonymous) {
      const [claims] = await pool.query(
        'SELECT submitted_at FROM survey_claims WHERE survey_id = ? AND member_id = ?',
        [survey.id, memberId]
      )
      if (claims.length) {
        claimed = true
        if (claims[0].submitted_at) {
          submitted = true
          myStatus = 'submitted'
        } else if (myStatus === 'open') myStatus = 'claimed'
      }
    } else {
      const [resp] = await pool.query(
        'SELECT id FROM survey_responses WHERE survey_id = ? AND member_id = ?',
        [survey.id, memberId]
      )
      if (resp.length) {
        submitted = true
        myStatus = 'submitted'
      }
    }

    res.json({
      success: true,
      data: {
        id: survey.id,
        title: survey.title,
        description: survey.description,
        fields: activeFields(survey),
        subjects: survey.subjects,
        is_satisfaction: survey.is_satisfaction,
        is_anonymous: survey.is_anonymous,
        start_at: survey.start_at,
        end_at: survey.end_at,
        max_responses: capacity.max,
        response_count: capacity.count,
        results_public: !!row.results_public,
        my_status: myStatus,
        claimed,
        submitted,
        can_submit: myStatus === 'open' || myStatus === 'claimed',
        window_ok: window.ok && capacity.ok && row.status === 'published',
        window_message: windowMessage,
      },
    })
  } catch (error) {
    console.error('[surveys] available detail', error)
    res.status(500).json({ success: false, message: '获取问卷失败' })
  }
})

router.post('/:id/claim', requireStudent, async (req, res) => {
  try {
    const memberId = req.student.id
    const [[member]] = await pool.query(
      'SELECT id, stage_role FROM members WHERE id = ?',
      [memberId]
    )
    if (!member) return res.status(404).json({ success: false, message: '成员不存在' })

    const [[row]] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id])
    if (!row || row.status !== 'published') {
      return res.status(404).json({ success: false, message: '问卷不存在或未发布' })
    }
    if (!row.is_anonymous) {
      return res.status(400).json({ success: false, message: '实名问卷无需领取凭证' })
    }
    if (!roleAllowed(row, member.stage_role)) {
      return res.status(403).json({ success: false, message: '不在投放范围内' })
    }
    const window = isWithinWindow(row)
    if (!window.ok) return res.status(400).json({ success: false, message: window.message })
    const capacity = await checkCapacity(pool, row)
    if (!capacity.ok) return res.status(400).json({ success: false, message: capacity.message })

    const [existing] = await pool.query(
      'SELECT id, submitted_at FROM survey_claims WHERE survey_id = ? AND member_id = ?',
      [row.id, memberId]
    )
    if (existing.length) {
      if (existing[0].submitted_at) {
        return res.status(400).json({ success: false, message: '您已提交过该问卷' })
      }
      // 已领取但未提交：重新签发 token（旧 hash 作废）
      const token = crypto.randomBytes(32).toString('hex')
      const tokenHash = hashToken(token)
      await pool.query(
        'UPDATE survey_claims SET token_hash = ?, claimed_at = NOW() WHERE id = ?',
        [tokenHash, existing[0].id]
      )
      return res.json({
        success: true,
        data: { token },
        message: '已重新签发匿名凭证，交卷时请勿携带登录令牌',
      })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(token)
    await pool.query(
      `INSERT INTO survey_claims (survey_id, member_id, token_hash) VALUES (?, ?, ?)`,
      [row.id, memberId, tokenHash]
    )
    res.json({
      success: true,
      data: { token },
      message: '已领取匿名凭证。交卷请求不会携带登录身份',
    })
  } catch (error) {
    console.error('[surveys] claim', error)
    res.status(500).json({ success: false, message: '领取凭证失败' })
  }
})

router.post('/:id/submit', async (req, res) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[row]] = await conn.query('SELECT * FROM surveys WHERE id = ? FOR UPDATE', [
      req.params.id,
    ])
    if (!row || row.status !== 'published') {
      await conn.rollback()
      return res.status(404).json({ success: false, message: '问卷不存在或未发布' })
    }
    const window = isWithinWindow(row)
    if (!window.ok) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: window.message })
    }
    const capacity = await checkCapacity(conn, row)
    if (!capacity.ok) {
      await closeSurveyIfFull(conn, row.id, capacity.max)
      await conn.commit()
      return res.status(400).json({ success: false, message: capacity.message })
    }

    const survey = normalizeSurvey(row)
    const fields = activeFields(survey)
    const { answers, token } = req.body || {}
    const err = validateAnswers(fields, answers)
    if (err) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: err })
    }

    if (row.is_anonymous) {
      // 匿名：拒绝携带 Authorization，避免学员怀疑身份被绑定
      if (req.headers.authorization) {
        await conn.rollback()
        return res.status(400).json({
          success: false,
          message: '匿名交卷请勿携带登录凭证。请使用已领取的匿名 token 提交。',
        })
      }
      if (!token) {
        await conn.rollback()
        return res.status(400).json({ success: false, message: '缺少匿名凭证，请先领取填写资格' })
      }
      const tokenHash = hashToken(token)
      const [claims] = await conn.query(
        'SELECT id, submitted_at FROM survey_claims WHERE survey_id = ? AND token_hash = ? FOR UPDATE',
        [row.id, tokenHash]
      )
      if (!claims.length) {
        await conn.rollback()
        return res.status(400).json({ success: false, message: '匿名凭证无效' })
      }
      if (claims[0].submitted_at) {
        await conn.rollback()
        return res.status(400).json({ success: false, message: '该凭证已交卷' })
      }

      await conn.query(
        `INSERT INTO survey_responses (survey_id, answers_json, member_id, token_hash)
         VALUES (?, ?, NULL, ?)`,
        [row.id, JSON.stringify(answers), tokenHash]
      )
      await conn.query('UPDATE survey_claims SET submitted_at = NOW() WHERE id = ?', [
        claims[0].id,
      ])
      await closeSurveyIfFull(conn, row.id, capacity.max)
      await conn.commit()
      return res.json({ success: true, message: '提交成功（匿名）' })
    }

    // 实名：必须学员登录
    const auth = req.headers.authorization?.replace('Bearer ', '')
    if (!auth) {
      await conn.rollback()
      return res.status(401).json({ success: false, message: '请先登录' })
    }
    let student
    try {
      student = jwt.verify(auth, process.env.JWT_SECRET || 'your-secret-key')
    } catch {
      await conn.rollback()
      return res.status(401).json({ success: false, message: '登录已失效' })
    }
    if (student.role !== 'student' && student.userType !== 'student') {
      await conn.rollback()
      return res.status(403).json({ success: false, message: '需要学员权限' })
    }

    const [[member]] = await conn.query('SELECT id, stage_role FROM members WHERE id = ?', [
      student.id,
    ])
    if (!member) {
      await conn.rollback()
      return res.status(404).json({ success: false, message: '成员不存在' })
    }
    if (!roleAllowed(row, member.stage_role)) {
      await conn.rollback()
      return res.status(403).json({ success: false, message: '不在投放范围内' })
    }

    const [exist] = await conn.query(
      'SELECT id FROM survey_responses WHERE survey_id = ? AND member_id = ?',
      [row.id, member.id]
    )
    if (exist.length) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: '您已提交过该问卷' })
    }

    await conn.query(
      `INSERT INTO survey_responses (survey_id, answers_json, member_id, token_hash)
       VALUES (?, ?, ?, NULL)`,
      [row.id, JSON.stringify(answers), member.id]
    )
    await closeSurveyIfFull(conn, row.id, capacity.max)
    await conn.commit()
    res.json({ success: true, message: '提交成功' })
  } catch (error) {
    try {
      await conn.rollback()
    } catch {
      /* ignore */
    }
    console.error('[surveys] submit', error)
    if (error?.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: '请勿重复提交' })
    }
    res.status(500).json({ success: false, message: '提交失败' })
  } finally {
    conn.release()
  }
})

// ─── 管理端 ───────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS response_count,
        (SELECT COUNT(*) FROM survey_claims c WHERE c.survey_id = s.id) AS claim_count
      FROM surveys s
      ORDER BY s.created_at DESC
    `)
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...normalizeSurvey(r),
        response_count: r.response_count,
        claim_count: r.claim_count,
      })),
    })
  } catch (error) {
    console.error('[surveys] list', error)
    res.status(500).json({ success: false, message: '获取列表失败' })
  }
})

router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id])
    if (!row) return res.status(404).json({ success: false, message: '问卷不存在' })
    res.json({ success: true, data: normalizeSurvey(row) })
  } catch (error) {
    console.error('[surveys] get', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description = '',
      fields = [],
      subjects = [],
      is_anonymous = true,
      start_at = null,
      end_at = null,
      max_responses = null,
      results_public = false,
      audience_roles = [],
      status = 'draft',
    } = req.body || {}
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: '请填写标题' })
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      return res.status(400).json({ success: false, message: '请至少添加一道题' })
    }
    if (Array.isArray(subjects) && subjects.length > 0 && subjects.some((s) => !s?.name)) {
      return res.status(400).json({ success: false, message: '评价对象姓名不能为空' })
    }
    const maxResp = parseMaxResponses(max_responses)
    const [result] = await pool.query(
      `INSERT INTO surveys
        (title, description, fields_json, subjects_json, is_anonymous, start_at, end_at, max_responses, results_public, status, audience_roles_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title.trim(),
        description || '',
        JSON.stringify(fields),
        JSON.stringify(subjects || []),
        is_anonymous ? 1 : 0,
        start_at || null,
        end_at || null,
        maxResp,
        results_public ? 1 : 0,
        ['draft', 'published', 'closed'].includes(status) ? status : 'draft',
        JSON.stringify(audience_roles || []),
        req.admin.username || null,
      ]
    )
    res.json({ success: true, data: { id: result.insertId } })
  } catch (error) {
    console.error('[surveys] create', error)
    res.status(500).json({ success: false, message: '创建失败' })
  }
})

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id])
    if (!row) return res.status(404).json({ success: false, message: '问卷不存在' })

    const title = req.body.title ?? row.title
    const description = req.body.description ?? row.description
    const fields = req.body.fields ?? parseJsonField(row.fields_json, [])
    const subjects =
      req.body.subjects !== undefined
        ? req.body.subjects
        : parseJsonField(row.subjects_json, [])
    const is_anonymous =
      req.body.is_anonymous !== undefined ? !!req.body.is_anonymous : !!row.is_anonymous
    const start_at = req.body.start_at !== undefined ? req.body.start_at : row.start_at
    const end_at = req.body.end_at !== undefined ? req.body.end_at : row.end_at
    const max_responses =
      req.body.max_responses !== undefined
        ? parseMaxResponses(req.body.max_responses)
        : parseMaxResponses(row.max_responses)
    const results_public =
      req.body.results_public !== undefined ? (req.body.results_public ? 1 : 0) : row.results_public ? 1 : 0
    const status = req.body.status ?? row.status
    const audience_roles =
      req.body.audience_roles !== undefined
        ? req.body.audience_roles
        : parseJsonField(row.audience_roles_json, [])

    await pool.query(
      `UPDATE surveys SET
        title = ?, description = ?, fields_json = ?, subjects_json = ?, is_anonymous = ?,
        start_at = ?, end_at = ?, max_responses = ?, results_public = ?, status = ?, audience_roles_json = ?
       WHERE id = ?`,
      [
        String(title).trim(),
        description || '',
        JSON.stringify(fields),
        JSON.stringify(subjects || []),
        is_anonymous ? 1 : 0,
        start_at || null,
        end_at || null,
        max_responses,
        results_public,
        status,
        JSON.stringify(audience_roles || []),
        req.params.id,
      ]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('[surveys] update', error)
    res.status(500).json({ success: false, message: '更新失败' })
  }
})

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM surveys WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (error) {
    console.error('[surveys] delete', error)
    res.status(500).json({ success: false, message: '删除失败' })
  }
})

/** 删除单份答卷；匿名时同步解除对应 claim 的已提交标记，允许该学员重填 */
router.delete('/:id/responses/:responseId', requireAdmin, async (req, res) => {
  try {
    const surveyId = Number(req.params.id)
    const responseId = Number(req.params.responseId)
    const [[resp]] = await pool.query(
      'SELECT id, survey_id, member_id, token_hash FROM survey_responses WHERE id = ? AND survey_id = ?',
      [responseId, surveyId]
    )
    if (!resp) return res.status(404).json({ success: false, message: '答卷不存在' })

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await conn.query('DELETE FROM survey_responses WHERE id = ?', [responseId])
      if (resp.token_hash) {
        await conn.query(
          'UPDATE survey_claims SET submitted_at = NULL WHERE survey_id = ? AND token_hash = ?',
          [surveyId, resp.token_hash]
        )
      }
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }

    res.json({ success: true, message: '答卷已删除' })
  } catch (error) {
    console.error('[surveys] delete response', error)
    res.status(500).json({ success: false, message: '删除答卷失败' })
  }
})

router.get('/:id/results', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id])
    if (!row) return res.status(404).json({ success: false, message: '问卷不存在' })
    const data = await buildSurveyResultsPayload(row, { includeIdentities: true })
    res.json({ success: true, data })
  } catch (error) {
    console.error('[surveys] results', error)
    res.status(500).json({ success: false, message: '获取结果失败' })
  }
})

/** 学员端：公开结果（实名表含填写者；匿名表仅统计） */
router.get('/:id/public-results', requireStudent, async (req, res) => {
  try {
    const memberId = req.student.id
    const [[member]] = await pool.query(
      'SELECT id, stage_role FROM members WHERE id = ?',
      [memberId]
    )
    if (!member) return res.status(404).json({ success: false, message: '成员不存在' })

    const [[row]] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id])
    if (!row) return res.status(404).json({ success: false, message: '问卷不存在' })
    if (!row.results_public) {
      return res.status(403).json({ success: false, message: '该问卷结果未公开' })
    }
    if (!['published', 'closed'].includes(row.status)) {
      return res.status(404).json({ success: false, message: '问卷不存在或未发布' })
    }
    if (!roleAllowed(row, member.stage_role)) {
      return res.status(403).json({ success: false, message: '不在投放范围内' })
    }

    // 实名公开：返回填写者；匿名：不暴露身份
    const data = await buildSurveyResultsPayload(row, {
      includeIdentities: !row.is_anonymous,
    })
    res.json({ success: true, data })
  } catch (error) {
    console.error('[surveys] public-results', error)
    res.status(500).json({ success: false, message: '获取结果失败' })
  }
})

export default router

async function buildSurveyResultsPayload(row, { includeIdentities }) {
  const survey = normalizeSurvey(row)

  let responses
  if (survey.is_anonymous || !includeIdentities) {
    const [rows] = await pool.query(
      `SELECT id, answers_json, submitted_at
       FROM survey_responses
       WHERE survey_id = ?
       ORDER BY submitted_at DESC`,
      [survey.id]
    )
    responses = rows.map((r) => ({
      id: r.id,
      answers: parseJsonField(r.answers_json, {}),
      submitted_at: r.submitted_at,
    }))
  } else {
    const [rows] = await pool.query(
      `SELECT r.id, r.answers_json, r.submitted_at, r.member_id, m.nickname, m.qq, m.avatar
       FROM survey_responses r
       LEFT JOIN members m ON m.id = r.member_id
       WHERE r.survey_id = ?
         AND (m.status IS NULL OR m.status != '已退队')
       ORDER BY r.submitted_at DESC`,
      [survey.id]
    )
    responses = rows.map((r) => ({
      id: r.id,
      answers: parseJsonField(r.answers_json, {}),
      submitted_at: r.submitted_at,
      member_id: r.member_id,
      nickname: r.nickname,
      qq: r.qq,
      avatar: r.avatar || null,
    }))
  }

  const [[claimStats]] = await pool.query(
    `SELECT
       COUNT(*) AS claimed,
       SUM(submitted_at IS NOT NULL) AS submitted_claims
     FROM survey_claims WHERE survey_id = ?`,
    [survey.id]
  )

  const fieldsForStats = activeFields(survey)
  const stats = {}
  for (const field of fieldsForStats || []) {
    if (
      !['single', 'multi', 'rating', 'matrix', 'subject_gate', 'text', 'textarea'].includes(
        field.type
      )
    ) {
      continue
    }
    const isText = field.type === 'text' || field.type === 'textarea'
    stats[field.id] = {
      label: field.label,
      type: field.type,
      subject_id: field.subject_id || null,
      subject_name: field.subject_name || null,
      counts: {},
      samples: isText ? [] : undefined,
    }
    const rowLabels = Object.fromEntries(
      (field.rows || []).map((r) => [r.id, r.label || r.id])
    )
    for (const resp of responses) {
      const val = resp.answers?.[field.id]
      if (val == null || val === '') continue
      if (isText) {
        const text = String(val).trim()
        if (!text) continue
        stats[field.id].samples.push(text)
        continue
      }
      if (field.type === 'matrix' && typeof val === 'object' && !Array.isArray(val)) {
        for (const [rowId, col] of Object.entries(val)) {
          const key = `${rowLabels[rowId] || rowId} · ${col}`
          stats[field.id].counts[key] = (stats[field.id].counts[key] || 0) + 1
        }
      } else if (Array.isArray(val)) {
        for (const v of val) {
          const key = String(v)
          stats[field.id].counts[key] = (stats[field.id].counts[key] || 0) + 1
        }
      } else {
        const key = String(val)
        stats[field.id].counts[key] = (stats[field.id].counts[key] || 0) + 1
      }
    }
  }

  const satisfaction_ranking = survey.is_satisfaction
    ? buildSatisfactionSummary(survey.subjects, fieldsForStats, responses)
    : null

  const window = isWithinWindow(row)

  return {
    survey: {
      id: survey.id,
      title: survey.title,
      description: survey.description,
      is_anonymous: survey.is_anonymous,
      is_satisfaction: survey.is_satisfaction,
      results_public: !!row.results_public,
      subjects: survey.subjects,
      fields: fieldsForStats,
      templates: survey.fields,
      start_at: survey.start_at,
      end_at: survey.end_at,
      status: survey.status,
      expired: !window.ok && String(window.message || '').includes('结束'),
      not_started: !window.ok && String(window.message || '').includes('尚未'),
      window_message: window.ok ? null : window.message,
    },
    response_count: responses.length,
    claim_count: survey.is_anonymous ? Number(claimStats?.claimed || 0) : null,
    stats,
    satisfaction_ranking,
    // 实名：返回答卷+填写者；匿名：不返回明细（仅统计）
    responses: includeIdentities ? responses : undefined,
  }
}
