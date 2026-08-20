import express from 'express'
import { pool } from '../config/database.js'
import { requireAdmin, requireStudent } from '../utils/authGate.js'
import {
  leaveSheetPresence,
  listSheetPresence,
  touchSheetPresence,
} from '../utils/sheetPresence.js'

const router = express.Router()

let tablesReady = false

const DEFAULT_SHEET = () => ({
  rows: 40,
  cols: 16,
  colWidths: Array.from({ length: 16 }, () => 120),
  rowHeights: Array.from({ length: 40 }, () => 34),
  cells: {},
  merges: [],
})

const newSheetId = () =>
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const DEFAULT_CONTENT = () => {
  const id = newSheetId()
  return {
    version: 2,
    activeSheetId: id,
    sheets: [{ id, name: '工作表1', content: DEFAULT_SHEET() }],
  }
}

function parseSheetGrid(raw) {
  const base = DEFAULT_SHEET()
  if (!raw || typeof raw !== 'object') return base
  const cols = Math.min(52, Math.max(5, Number(raw.cols) || 16))
  const rows = Math.min(200, Math.max(10, Number(raw.rows) || 40))
  const colWidths = Array.from({ length: cols }, (_, i) => {
    const w = Number(raw.colWidths?.[i])
    return Number.isFinite(w) ? Math.min(480, Math.max(48, Math.round(w))) : 120
  })
  const rowHeights = Array.from({ length: rows }, (_, i) => {
    const h = Number(raw.rowHeights?.[i])
    return Number.isFinite(h) ? Math.min(240, Math.max(24, Math.round(h))) : 34
  })
  return {
    rows,
    cols,
    colWidths,
    rowHeights,
    cells: raw.cells && typeof raw.cells === 'object' ? raw.cells : {},
    merges: Array.isArray(raw.merges) ? raw.merges : [],
    gridStyle: raw.gridStyle === 'bold' ? 'bold' : 'normal',
  }
}

function parseContent(raw) {
  if (!raw) return DEFAULT_CONTENT()
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed?.version === 2 && Array.isArray(parsed.sheets) && parsed.sheets.length > 0) {
      const sheets = parsed.sheets
        .slice(0, 30)
        .map((s, i) => ({
          id: String(s?.id || newSheetId()),
          name: String(s?.name || `工作表${i + 1}`).trim().slice(0, 32) || `工作表${i + 1}`,
          content: parseSheetGrid(s?.content),
        }))
      if (!sheets.length) return DEFAULT_CONTENT()
      const activeSheetId =
        sheets.find((s) => s.id === parsed.activeSheetId)?.id || sheets[0].id
      return { version: 2, activeSheetId, sheets }
    }
    // 旧版：单 sheet 网格 JSON（固定 id，避免每次解析都变导致误记历史）
    if (parsed && (parsed.cells != null || parsed.rows != null || parsed.cols != null)) {
      const id = 's_legacy_main'
      return {
        version: 2,
        activeSheetId: id,
        sheets: [{ id, name: '工作表1', content: parseSheetGrid(parsed) }],
      }
    }
    return DEFAULT_CONTENT()
  } catch {
    return DEFAULT_CONTENT()
  }
}

async function ensureSheetTables() {
  if (tablesReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbooks (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(200) NOT NULL,
      description TEXT NULL,
      access_mode ENUM('shared', 'student_readonly', 'assigned') NOT NULL DEFAULT 'student_readonly'
        COMMENT 'shared=全员可改; student_readonly=学员只读; assigned=指定学员可填',
      status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
      is_pinned TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理端置顶',
      sort_order INT NOT NULL DEFAULT 0 COMMENT '手动排序，越小越靠前',
      content_json LONGTEXT NOT NULL,
      created_by VARCHAR(100) NULL,
      updated_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workbook_status (status),
      INDEX idx_workbook_mode (access_mode)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='在线表格文档'
  `)
  try {
    await pool.query(`
      ALTER TABLE workbooks
      MODIFY COLUMN access_mode ENUM('shared', 'student_readonly', 'assigned') NOT NULL DEFAULT 'student_readonly'
        COMMENT 'shared=全员可改; student_readonly=学员只读; assigned=指定学员可填'
    `)
  } catch (e) {
    /* 已是新枚举或暂不可改 */
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbook_revisions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      workbook_id INT NOT NULL,
      content_json LONGTEXT NOT NULL COMMENT '该次编辑之前的表格快照',
      edited_by VARCHAR(100) NULL COMMENT '本次编辑者（回退即回到此人改之前）',
      edited_by_type ENUM('admin', 'student') NOT NULL DEFAULT 'admin',
      edited_by_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wb_rev_workbook (workbook_id, id DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='表格编辑历史（存编辑前状态）'
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbook_assignees (
      workbook_id INT NOT NULL,
      member_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workbook_id, member_id),
      INDEX idx_wb_assignee_member (member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='指定可填写学员'
  `)
  // 置顶 / 手动排序（已有库用 ALTER 补齐）
  for (const sql of [
    `ALTER TABLE workbooks ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理端置顶' AFTER status`,
    `ALTER TABLE workbooks ADD COLUMN sort_order INT NOT NULL DEFAULT 0 COMMENT '手动排序，越小越靠前' AFTER is_pinned`,
    `ALTER TABLE workbooks ADD INDEX idx_workbook_pin_sort (is_pinned, sort_order)`,
  ]) {
    try {
      await pool.query(sql)
    } catch {
      /* 列/索引已存在 */
    }
  }
  tablesReady = true
}

const LIST_ORDER_SQL = `w.is_pinned DESC, w.sort_order ASC, w.updated_at DESC`

async function nextWorkbookSortOrder() {
  const [[row]] = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM workbooks WHERE status != 'archived'`
  )
  return Number(row?.n) || 1
}

router.use(async (req, res, next) => {
  try {
    await ensureSheetTables()
    next()
  } catch (e) {
    console.error('[sheets] ensure', e)
    res.status(500).json({ success: false, message: '数据库初始化失败' })
  }
})

const REVISION_COALESCE_MS = 5 * 60 * 1000
const MAX_REVISIONS = 80

/** 内容有变时记录「编辑前」快照；同一人 5 分钟内连续保存合并为一次历史（force 时不合并） */
async function recordRevisionBeforeEdit(workbookId, oldContentJson, editor, newContentJson, opts = {}) {
  const force = !!opts.force
  const oldNorm = JSON.stringify(parseContent(oldContentJson))
  if (newContentJson != null) {
    const newNorm = JSON.stringify(parseContent(newContentJson))
    if (oldNorm === newNorm) return false
  }

  if (!force) {
    const [[last]] = await pool.query(
      `SELECT id, edited_by, created_at FROM workbook_revisions
       WHERE workbook_id = ? ORDER BY id DESC LIMIT 1`,
      [workbookId]
    )
    if (
      last &&
      last.edited_by === editor.name &&
      Date.now() - new Date(last.created_at).getTime() < REVISION_COALESCE_MS
    ) {
      return false
    }
  }

  await pool.query(
    `INSERT INTO workbook_revisions
      (workbook_id, content_json, edited_by, edited_by_type, edited_by_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      workbookId,
      oldNorm,
      opts.editedByLabel || editor.name || null,
      editor.type || 'admin',
      editor.id ?? null,
    ]
  )

  const [[{ cnt }]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM workbook_revisions WHERE workbook_id = ?`,
    [workbookId]
  )
  if (cnt > MAX_REVISIONS) {
    const drop = Number(cnt) - MAX_REVISIONS
    await pool.query(
      `DELETE FROM workbook_revisions
       WHERE workbook_id = ?
       ORDER BY id ASC
       LIMIT ?`,
      [workbookId, drop]
    )
  }
  return true
}

async function getRevisionContent(workbookId, revId) {
  const [[rev]] = await pool.query(
    `SELECT id, workbook_id, content_json, edited_by, edited_by_type, created_at
     FROM workbook_revisions WHERE id = ? AND workbook_id = ?`,
    [revId, workbookId]
  )
  if (!rev) return null
  return {
    id: rev.id,
    edited_by: rev.edited_by || '未知',
    edited_by_type: rev.edited_by_type,
    created_at: rev.created_at,
    content: parseContent(rev.content_json),
  }
}

async function listRevisions(workbookId) {
  const [rows] = await pool.query(
    `SELECT id, edited_by, edited_by_type, edited_by_id, created_at
     FROM workbook_revisions
     WHERE workbook_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [workbookId, MAX_REVISIONS]
  )

  const studentIds = [
    ...new Set(
      rows
        .filter((r) => r.edited_by_type === 'student' && r.edited_by_id)
        .map((r) => Number(r.edited_by_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ]
  const adminIds = [
    ...new Set(
      rows
        .filter((r) => r.edited_by_type === 'admin' && r.edited_by_id)
        .map((r) => Number(r.edited_by_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ]
  const nameKeys = [
    ...new Set(
      rows
        .map((r) => String(r.edited_by || '').replace(/（回退前）$/, '').trim())
        .filter(Boolean)
    ),
  ]

  const memberById = new Map()
  const memberByName = new Map()
  if (studentIds.length) {
    const [ms] = await pool.query(
      `SELECT id, nickname, avatar, qq FROM members WHERE id IN (${studentIds.map(() => '?').join(',')})`,
      studentIds
    )
    for (const m of ms) {
      memberById.set(Number(m.id), m)
      if (m.nickname) memberByName.set(String(m.nickname), m)
    }
  }
  if (nameKeys.length) {
    const [ms] = await pool.query(
      `SELECT id, nickname, avatar, qq FROM members WHERE nickname IN (${nameKeys.map(() => '?').join(',')})`,
      nameKeys
    )
    for (const m of ms) {
      if (!memberById.has(Number(m.id))) memberById.set(Number(m.id), m)
      if (m.nickname) memberByName.set(String(m.nickname), m)
    }
  }

  const adminById = new Map()
  const adminByName = new Map()
  if (adminIds.length) {
    const [as_] = await pool.query(
      `SELECT id, username, name, avatar FROM admins WHERE id IN (${adminIds.map(() => '?').join(',')})`,
      adminIds
    )
    for (const a of as_) {
      adminById.set(Number(a.id), a)
      if (a.username) adminByName.set(String(a.username), a)
      if (a.name) adminByName.set(String(a.name), a)
    }
  }
  if (nameKeys.length) {
    const [as_] = await pool.query(
      `SELECT id, username, name, avatar FROM admins
       WHERE username IN (${nameKeys.map(() => '?').join(',')})
          OR name IN (${nameKeys.map(() => '?').join(',')})`,
      [...nameKeys, ...nameKeys]
    )
    for (const a of as_) {
      if (!adminById.has(Number(a.id))) adminById.set(Number(a.id), a)
      if (a.username) adminByName.set(String(a.username), a)
      if (a.name) adminByName.set(String(a.name), a)
    }
  }

  const resolveProfile = (r) => {
    const rawName = String(r.edited_by || '').trim()
    const baseName = rawName.replace(/（回退前）$/, '').trim()
    if (r.edited_by_type === 'student') {
      const m =
        (r.edited_by_id && memberById.get(Number(r.edited_by_id))) ||
        memberByName.get(baseName) ||
        null
      return {
        avatar: m?.avatar || null,
        qq: m?.qq || null,
        display_name: rawName || '未知',
      }
    }
    const a =
      (r.edited_by_id && adminById.get(Number(r.edited_by_id))) ||
      adminByName.get(baseName) ||
      null
    return {
      avatar: a?.avatar || null,
      qq: null,
      display_name: rawName || '未知',
    }
  }

  const editorsMap = new Map()
  for (const r of rows) {
    const profile = resolveProfile(r)
    const name = profile.display_name
    const prev = editorsMap.get(name) || {
      name,
      count: 0,
      last_at: null,
      type: r.edited_by_type,
      avatar: profile.avatar,
      qq: profile.qq,
    }
    prev.count += 1
    if (!prev.last_at || new Date(r.created_at) > new Date(prev.last_at)) {
      prev.last_at = r.created_at
      prev.type = r.edited_by_type
      prev.avatar = profile.avatar
      prev.qq = profile.qq
    }
    editorsMap.set(name, prev)
  }
  return {
    revisions: rows.map((r) => {
      const profile = resolveProfile(r)
      return {
        id: r.id,
        edited_by: profile.display_name,
        edited_by_type: r.edited_by_type,
        edited_by_id: r.edited_by_id,
        avatar: profile.avatar,
        qq: profile.qq,
        created_at: r.created_at,
      }
    }),
    editors: Array.from(editorsMap.values()).sort(
      (a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
    ),
  }
}

function serializeRow(row, { includeContent = false } = {}) {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description || '',
    access_mode: row.access_mode,
    status: row.status,
    is_pinned: !!Number(row.is_pinned),
    sort_order: Number(row.sort_order) || 0,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    can_edit: !!row.can_edit,
    assignee_ids: Array.isArray(row.assignee_ids) ? row.assignee_ids : undefined,
    assignee_count: row.assignee_count != null ? Number(row.assignee_count) : undefined,
  }
  if (includeContent) {
    base.content = parseContent(row.content_json)
  }
  return base
}

function normalizeAccessMode(mode) {
  if (mode === 'shared') return 'shared'
  if (mode === 'assigned') return 'assigned'
  return 'student_readonly'
}

async function getAssigneeIds(workbookId) {
  const [rows] = await pool.query(
    `SELECT member_id FROM workbook_assignees WHERE workbook_id = ? ORDER BY member_id ASC`,
    [workbookId]
  )
  return rows.map((r) => Number(r.member_id))
}

async function setAssignees(workbookId, memberIds) {
  const ids = Array.from(
    new Set(
      (Array.isArray(memberIds) ? memberIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  )
  await pool.query(`DELETE FROM workbook_assignees WHERE workbook_id = ?`, [workbookId])
  for (const memberId of ids) {
    await pool.query(
      `INSERT INTO workbook_assignees (workbook_id, member_id) VALUES (?, ?)`,
      [workbookId, memberId]
    )
  }
  return ids
}

async function isAssignee(workbookId, memberId) {
  const [[row]] = await pool.query(
    `SELECT 1 AS ok FROM workbook_assignees WHERE workbook_id = ? AND member_id = ? LIMIT 1`,
    [workbookId, memberId]
  )
  return !!row
}

async function studentCanEditWorkbook(row, studentId) {
  if (row.access_mode === 'shared') return true
  if (row.access_mode === 'assigned') return await isAssignee(row.id, studentId)
  return false
}

async function studentCanViewWorkbook(row, studentId) {
  if (row.access_mode === 'assigned') return await isAssignee(row.id, studentId)
  return true
}

// ─── 学员端（必须在 /:id 之前） ───────────────────────────

router.get('/student/list', requireStudent, async (req, res) => {
  try {
    const studentId = req.student.id
    const [rows] = await pool.query(
      `SELECT w.id, w.title, w.description, w.access_mode, w.status, w.is_pinned, w.sort_order,
              w.updated_by, w.updated_at, w.created_at
       FROM workbooks w
       LEFT JOIN workbook_assignees a ON a.workbook_id = w.id AND a.member_id = ?
       WHERE w.status = 'published'
         AND (w.access_mode != 'assigned' OR a.member_id IS NOT NULL)
       ORDER BY ${LIST_ORDER_SQL}`,
      [studentId]
    )
    const data = []
    for (const r of rows) {
      data.push(
        serializeRow({
          ...r,
          can_edit: await studentCanEditWorkbook(r, studentId),
        })
      )
    }
    res.json({ success: true, data })
  } catch (error) {
    console.error('[sheets] student list', error)
    res.status(500).json({ success: false, message: '获取表格列表失败' })
  }
})

router.get('/student/:id', requireStudent, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status !== 'published') {
      return res.status(404).json({ success: false, message: '表格不存在或未发布' })
    }
    if (!(await studentCanViewWorkbook(row, req.student.id))) {
      return res.status(403).json({ success: false, message: '你没有权限查看该表格' })
    }
    const canEdit = await studentCanEditWorkbook(row, req.student.id)
    res.json({
      success: true,
      data: serializeRow({ ...row, can_edit: canEdit }, { includeContent: true }),
    })
  } catch (error) {
    console.error('[sheets] student get', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.put('/student/:id', requireStudent, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status !== 'published') {
      return res.status(404).json({ success: false, message: '表格不存在或未发布' })
    }
    if (!(await studentCanEditWorkbook(row, req.student.id))) {
      return res.status(403).json({
        success: false,
        message:
          row.access_mode === 'assigned'
            ? '你不在可填写名单中'
            : '该表格为只读，仅管理员可修改',
      })
    }
    if (req.body.content === undefined) {
      return res.status(400).json({ success: false, message: '缺少表格内容' })
    }
    const nickname = req.student.nickname || req.student.username || `学员#${req.student.id}`
    const nextJson = JSON.stringify(parseContent(req.body.content))
    await recordRevisionBeforeEdit(
      row.id,
      row.content_json,
      { name: nickname, type: 'student', id: req.student.id },
      nextJson
    )
    await pool.query(`UPDATE workbooks SET content_json = ?, updated_by = ? WHERE id = ?`, [
      nextJson,
      nickname,
      req.params.id,
    ])
    const [[fresh]] = await pool.query(
      `SELECT updated_at, updated_by FROM workbooks WHERE id = ?`,
      [req.params.id]
    )
    res.json({
      success: true,
      message: '已保存',
      data: {
        updated_at: fresh?.updated_at || null,
        updated_by: fresh?.updated_by || null,
      },
    })
  } catch (error) {
    console.error('[sheets] student save', error)
    res.status(500).json({ success: false, message: '保存失败' })
  }
})

router.get('/student/:id/revisions', requireStudent, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status !== 'published') {
      return res.status(404).json({ success: false, message: '表格不存在或未发布' })
    }
    if (!(await studentCanViewWorkbook(row, req.student.id))) {
      return res.status(403).json({ success: false, message: '你没有权限查看该表格' })
    }
    const data = await listRevisions(row.id)
    res.json({ success: true, data })
  } catch (error) {
    console.error('[sheets] student revisions', error)
    res.status(500).json({ success: false, message: '获取历史失败' })
  }
})

router.get('/student/:id/revisions/:revId', requireStudent, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status !== 'published') {
      return res.status(404).json({ success: false, message: '表格不存在或未发布' })
    }
    if (!(await studentCanViewWorkbook(row, req.student.id))) {
      return res.status(403).json({ success: false, message: '你没有权限查看该表格' })
    }
    const data = await getRevisionContent(row.id, req.params.revId)
    if (!data) return res.status(404).json({ success: false, message: '历史记录不存在' })
    res.json({ success: true, data })
  } catch (error) {
    console.error('[sheets] student revision detail', error)
    res.status(500).json({ success: false, message: '获取历史版本失败' })
  }
})

router.post('/student/:id/revisions/:revId/restore', requireStudent, async (_req, res) => {
  return res.status(403).json({ success: false, message: '学员不可回退表格，请联系管理员' })
})

/** 学员：表格在场心跳（内存，不写库） */
router.post('/student/:id/presence', requireStudent, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT id, status, access_mode FROM workbooks WHERE id = ?', [
      req.params.id,
    ])
    if (!row || row.status !== 'published') {
      return res.status(404).json({ success: false, message: '表格不存在或未发布' })
    }
    if (!(await studentCanViewWorkbook(row, req.student.id))) {
      return res.status(403).json({ success: false, message: '你没有权限查看该表格' })
    }
    const canEdit = await studentCanEditWorkbook(row, req.student.id)
    const editing = canEdit && !!req.body?.editing
    const sessionId = req.body?.session_id || req.body?.sessionId || ''
    const name =
      req.student.nickname || req.student.name || req.student.username || `学员${req.student.id}`
    const presence = touchSheetPresence(row.id, {
      sessionId,
      userId: req.student.id,
      role: 'student',
      name,
      editing,
    })
    res.json({ success: true, data: { presence, self_editing: editing } })
  } catch (error) {
    console.error('[sheets] student presence', error)
    res.status(500).json({ success: false, message: '同步在场状态失败' })
  }
})

router.delete('/student/:id/presence', requireStudent, async (req, res) => {
  try {
    const sessionId = req.body?.session_id || req.body?.sessionId || req.query?.session_id || ''
    const presence = leaveSheetPresence(req.params.id, {
      sessionId,
      userId: req.student.id,
      role: 'student',
      name: '',
    })
    res.json({ success: true, data: { presence } })
  } catch (error) {
    res.status(500).json({ success: false, message: '离开失败' })
  }
})

// ─── 管理端 ───────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT w.id, w.title, w.description, w.access_mode, w.status, w.is_pinned, w.sort_order,
              w.created_by, w.updated_by, w.created_at, w.updated_at,
              (SELECT COUNT(*) FROM workbook_assignees a WHERE a.workbook_id = w.id) AS assignee_count
       FROM workbooks w
       WHERE w.status != 'archived'
       ORDER BY ${LIST_ORDER_SQL}`
    )
    res.json({
      success: true,
      data: rows.map((r) => serializeRow({ ...r, can_edit: true })),
    })
  } catch (error) {
    console.error('[sheets] list', error)
    res.status(500).json({ success: false, message: '获取表格列表失败' })
  }
})

/** 批量保存手动排序（ids 从前到后） */
router.put('/reorder', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : []
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: '请提供排序列表' })
    }
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      for (let i = 0; i < ids.length; i++) {
        await conn.query(
          `UPDATE workbooks SET sort_order = ? WHERE id = ? AND status != 'archived'`,
          [i, ids[i]]
        )
      }
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
    res.json({ success: true, message: '排序已保存' })
  } catch (error) {
    console.error('[sheets] reorder', error)
    res.status(500).json({ success: false, message: '保存排序失败' })
  }
})

router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description = '',
      access_mode = 'student_readonly',
      status = 'draft',
      content,
      assignee_ids,
    } = req.body || {}
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: '请填写标题' })
    }
    const mode = normalizeAccessMode(access_mode)
    const st = ['draft', 'published', 'archived'].includes(status) ? status : 'draft'
    const contentJson = JSON.stringify(parseContent(content || DEFAULT_CONTENT()))
    const sortOrder = await nextWorkbookSortOrder()
    const [result] = await pool.query(
      `INSERT INTO workbooks
        (title, description, access_mode, status, is_pinned, sort_order, content_json, created_by, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        title.trim(),
        description || '',
        mode,
        st,
        sortOrder,
        contentJson,
        req.admin.username || null,
        req.admin.username || null,
      ]
    )
    if (mode === 'assigned' || Array.isArray(assignee_ids)) {
      await setAssignees(result.insertId, assignee_ids || [])
    }
    res.json({ success: true, data: { id: result.insertId } })
  } catch (error) {
    console.error('[sheets] create', error)
    res.status(500).json({ success: false, message: '创建失败' })
  }
})

router.post('/:id/copy', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }
    const {
      title,
      description,
      access_mode,
      status = 'draft',
      assignee_ids,
    } = req.body || {}
    const nextTitle = (title != null ? String(title) : `${row.title}（副本）`).trim()
    if (!nextTitle) {
      return res.status(400).json({ success: false, message: '请填写标题' })
    }
    const mode = access_mode !== undefined ? normalizeAccessMode(access_mode) : 'assigned'
    const st = ['draft', 'published', 'archived'].includes(status) ? status : 'draft'
    const nextDesc = description !== undefined ? description || '' : row.description || ''
    const sortOrder = await nextWorkbookSortOrder()
    const [result] = await pool.query(
      `INSERT INTO workbooks
        (title, description, access_mode, status, is_pinned, sort_order, content_json, created_by, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        nextTitle,
        nextDesc,
        mode,
        st,
        sortOrder,
        row.content_json,
        req.admin.username || null,
        req.admin.username || null,
      ]
    )
    const ids =
      assignee_ids !== undefined
        ? await setAssignees(result.insertId, assignee_ids)
        : mode === 'assigned'
          ? await setAssignees(result.insertId, await getAssigneeIds(row.id))
          : []
    res.json({
      success: true,
      message: '已复制',
      data: { id: result.insertId, assignee_ids: ids },
    })
  } catch (error) {
    console.error('[sheets] copy', error)
    res.status(500).json({ success: false, message: '复制失败' })
  }
})

/** 管理端：表格在场心跳（内存，不写库） */
router.post('/:id/presence', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query(`SELECT id, status FROM workbooks WHERE id = ?`, [req.params.id])
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }
    const editing = !!req.body?.editing
    const sessionId = req.body?.session_id || req.body?.sessionId || ''
    const name = req.admin.username || req.admin.name || `管理员${req.admin.id}`
    const presence = touchSheetPresence(row.id, {
      sessionId,
      userId: req.admin.id,
      role: 'admin',
      name,
      editing,
    })
    res.json({ success: true, data: { presence, self_editing: editing } })
  } catch (error) {
    console.error('[sheets] admin presence', error)
    res.status(500).json({ success: false, message: '同步在场状态失败' })
  }
})

router.delete('/:id/presence', requireAdmin, async (req, res) => {
  try {
    const sessionId = req.body?.session_id || req.body?.sessionId || req.query?.session_id || ''
    const presence = leaveSheetPresence(req.params.id, {
      sessionId,
      userId: req.admin.id,
      role: 'admin',
      name: '',
    })
    res.json({ success: true, data: { presence } })
  } catch (error) {
    res.status(500).json({ success: false, message: '离开失败' })
  }
})

router.get('/:id/presence', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: { presence: listSheetPresence(req.params.id) } })
  } catch (error) {
    res.status(500).json({ success: false, message: '获取在场状态失败' })
  }
})

/** 置顶 / 取消置顶 */
router.post('/:id/pin', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT id, status, is_pinned FROM workbooks WHERE id = ?`,
      [req.params.id]
    )
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }
    const next =
      req.body?.pinned !== undefined ? !!req.body.pinned : !Number(row.is_pinned)
    await pool.query(`UPDATE workbooks SET is_pinned = ? WHERE id = ?`, [next ? 1 : 0, row.id])
    res.json({
      success: true,
      message: next ? '已置顶' : '已取消置顶',
      data: { id: row.id, is_pinned: next },
    })
  } catch (error) {
    console.error('[sheets] pin', error)
    res.status(500).json({ success: false, message: '置顶操作失败' })
  }
})

router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }
    const assignee_ids = await getAssigneeIds(row.id)
    res.json({
      success: true,
      data: serializeRow(
        { ...row, can_edit: true, assignee_ids, assignee_count: assignee_ids.length },
        { includeContent: true }
      ),
    })
  } catch (error) {
    console.error('[sheets] get', error)
    res.status(500).json({ success: false, message: '获取失败' })
  }
})

router.get('/:id/revisions', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT id, status FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }
    const data = await listRevisions(row.id)
    res.json({ success: true, data })
  } catch (error) {
    console.error('[sheets] revisions', error)
    res.status(500).json({ success: false, message: '获取历史失败' })
  }
})

router.get('/:id/revisions/:revId', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT id, status FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }
    const data = await getRevisionContent(row.id, req.params.revId)
    if (!data) return res.status(404).json({ success: false, message: '历史记录不存在' })
    res.json({ success: true, data })
  } catch (error) {
    console.error('[sheets] revision detail', error)
    res.status(500).json({ success: false, message: '获取历史版本失败' })
  }
})

router.post('/:id/revisions/:revId/restore', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }
    const [[rev]] = await pool.query(
      `SELECT * FROM workbook_revisions WHERE id = ? AND workbook_id = ?`,
      [req.params.revId, row.id]
    )
    if (!rev) return res.status(404).json({ success: false, message: '历史记录不存在' })

    const restoreJson = JSON.stringify(parseContent(rev.content_json))
    const adminName = req.admin.username || '管理员'
    // 强制写入：把回退前的当前内容记入历史，避免与自动保存合并导致丢失
    await recordRevisionBeforeEdit(
      row.id,
      row.content_json,
      { name: adminName, type: 'admin', id: req.admin.id },
      restoreJson,
      { force: true, editedByLabel: `${adminName}（回退前）` }
    )
    await pool.query(`UPDATE workbooks SET content_json = ?, updated_by = ? WHERE id = ?`, [
      restoreJson,
      adminName,
      row.id,
    ])
    res.json({
      success: true,
      message: `已回退到「${rev.edited_by || '未知'}」编辑前的状态`,
      data: { content: parseContent(restoreJson) },
    })
  } catch (error) {
    console.error('[sheets] restore', error)
    res.status(500).json({ success: false, message: '回退失败' })
  }
})

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM workbooks WHERE id = ?', [req.params.id])
    if (!row || row.status === 'archived') {
      return res.status(404).json({ success: false, message: '表格不存在' })
    }

    const title = req.body.title !== undefined ? String(req.body.title).trim() : row.title
    if (!title) return res.status(400).json({ success: false, message: '请填写标题' })
    const description =
      req.body.description !== undefined ? req.body.description || '' : row.description
    const access_mode =
      req.body.access_mode !== undefined
        ? normalizeAccessMode(req.body.access_mode)
        : row.access_mode
    const status =
      req.body.status !== undefined && ['draft', 'published', 'archived'].includes(req.body.status)
        ? req.body.status
        : row.status

    let contentJson = row.content_json
    if (req.body.content !== undefined) {
      contentJson = JSON.stringify(parseContent(req.body.content))
      await recordRevisionBeforeEdit(
        row.id,
        row.content_json,
        { name: req.admin.username || '管理员', type: 'admin', id: req.admin.id },
        contentJson
      )
    }

    await pool.query(
      `UPDATE workbooks SET
        title = ?, description = ?, access_mode = ?, status = ?, content_json = ?, updated_by = ?
       WHERE id = ?`,
      [title, description, access_mode, status, contentJson, req.admin.username || null, req.params.id]
    )
    if (req.body.assignee_ids !== undefined || access_mode !== 'assigned') {
      if (access_mode === 'assigned') {
        await setAssignees(row.id, req.body.assignee_ids || [])
      } else if (req.body.assignee_ids !== undefined || req.body.access_mode !== undefined) {
        await setAssignees(row.id, [])
      }
    }
    const [[fresh]] = await pool.query(
      `SELECT updated_at, updated_by FROM workbooks WHERE id = ?`,
      [req.params.id]
    )
    res.json({
      success: true,
      message: '已保存',
      data: {
        updated_at: fresh?.updated_at || null,
        updated_by: fresh?.updated_by || null,
      },
    })
  } catch (error) {
    console.error('[sheets] update', error)
    res.status(500).json({ success: false, message: '保存失败' })
  }
})

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id
    await pool.query(`DELETE FROM workbook_assignees WHERE workbook_id = ?`, [id])
    await pool.query(`DELETE FROM workbook_revisions WHERE workbook_id = ?`, [id])
    await pool.query(`UPDATE workbooks SET status = 'archived' WHERE id = ?`, [id])
    res.json({ success: true, message: '已归档删除' })
  } catch (error) {
    console.error('[sheets] delete', error)
    res.status(500).json({ success: false, message: '删除失败' })
  }
})

export default router
