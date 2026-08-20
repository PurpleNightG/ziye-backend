import express from 'express'
import jwt from 'jsonwebtoken'
import { pool } from '../config/database.js'
import { requireAdmin } from '../utils/authGate.js'

const router = express.Router()

let tablesReady = false

async function ensureOpinionBoxTable() {
  if (tablesReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS opinion_box (
      id INT PRIMARY KEY AUTO_INCREMENT,
      member_id INT NOT NULL COMMENT '提交人（匿名时管理端不展示）',
      is_anonymous TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=匿名展示',
      category VARCHAR(50) NOT NULL DEFAULT '建议' COMMENT '分类',
      content TEXT NOT NULL COMMENT '意见内容',
      status ENUM('pending','read','archived') NOT NULL DEFAULT 'pending' COMMENT '处理状态',
      admin_note TEXT NULL COMMENT '管理员备注',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_opinion_member (member_id),
      INDEX idx_opinion_status (status),
      INDEX idx_opinion_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='意见箱'
  `)
  tablesReady = true
}

router.use(async (req, res, next) => {
  try {
    await ensureOpinionBoxTable()
    next()
  } catch (e) {
    console.error('[opinion-box] ensure tables', e)
    res.status(500).json({ success: false, message: '数据库初始化失败' })
  }
})

function requireStudent(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ success: false, message: '未登录' })
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    if (decoded.role !== 'student' && decoded.userType !== 'student') {
      return res.status(403).json({ success: false, message: '需要学员权限' })
    }
    req.student = decoded
    next()
  } catch {
    return res.status(401).json({ success: false, message: '认证令牌无效或已过期' })
  }
}

const ALLOWED_CATEGORIES = ['建议', '问题反馈', '表扬', '其他']

function mapStudentRow(row) {
  return {
    id: row.id,
    is_anonymous: !!row.is_anonymous,
    category: row.category,
    content: row.content,
    status: row.status,
    admin_note: row.admin_note,
    created_at: row.created_at,
  }
}

function mapAdminRow(row) {
  const anonymous = !!row.is_anonymous
  return {
    id: row.id,
    is_anonymous: anonymous,
    category: row.category,
    content: row.content,
    status: row.status,
    admin_note: row.admin_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // 匿名时不返回可识别信息
    member_id: anonymous ? null : row.member_id,
    member_name: anonymous ? null : row.member_name,
    member_qq: anonymous ? null : row.member_qq,
    avatar: anonymous ? null : (row.avatar || null),
    display_label: anonymous ? '匿名学员' : (row.member_name || `学员#${row.member_id}`),
  }
}

/** 学员：提交意见 */
router.post('/', requireStudent, async (req, res) => {
  try {
    const memberId = Number(req.student.id)
    const content = String(req.body?.content || '').trim()
    const isAnonymous = req.body?.is_anonymous !== false && req.body?.is_anonymous !== 0
    let category = String(req.body?.category || '建议').trim()
    if (!ALLOWED_CATEGORIES.includes(category)) category = '其他'

    if (!content) {
      return res.status(400).json({ success: false, message: '请填写意见内容' })
    }
    if (content.length > 2000) {
      return res.status(400).json({ success: false, message: '内容请控制在 2000 字以内' })
    }

    // 简单限流：每人每天最多 8 条
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM opinion_box
       WHERE member_id = ? AND created_at >= CURDATE()`,
      [memberId]
    )
    if (Number(countRows[0]?.cnt || 0) >= 8) {
      return res.status(429).json({ success: false, message: '今日提交次数已达上限，请明天再试' })
    }

    const [result] = await pool.query(
      `INSERT INTO opinion_box (member_id, is_anonymous, category, content)
       VALUES (?, ?, ?, ?)`,
      [memberId, isAnonymous ? 1 : 0, category, content]
    )

    res.json({
      success: true,
      message: '已投入意见箱',
      data: { id: result.insertId },
    })
  } catch (error) {
    console.error('[opinion-box] submit', error)
    res.status(500).json({ success: false, message: '提交失败' })
  }
})

/** 学员：我的投递记录 */
router.get('/my', requireStudent, async (req, res) => {
  try {
    const memberId = Number(req.student.id)
    const [rows] = await pool.query(
      `SELECT id, is_anonymous, category, content, status, admin_note, created_at
       FROM opinion_box
       WHERE member_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [memberId]
    )
    res.json({ success: true, data: (rows || []).map(mapStudentRow) })
  } catch (error) {
    console.error('[opinion-box] my', error)
    res.status(500).json({ success: false, message: '加载失败' })
  }
})

/** 管理端：列表 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim()
    const params = []
    const conditions = ["(m.status IS NULL OR m.status != '已退队')"]
    if (status && ['pending', 'read', 'archived'].includes(status)) {
      conditions.push('o.status = ?')
      params.push(status)
    }
    const where = `WHERE ${conditions.join(' AND ')}`

    const [rows] = await pool.query(
      `SELECT
         o.id, o.member_id, o.is_anonymous, o.category, o.content,
         o.status, o.admin_note, o.created_at, o.updated_at,
         m.nickname AS member_name, m.qq AS member_qq, m.avatar AS avatar
       FROM opinion_box o
       LEFT JOIN members m ON m.id = o.member_id
       ${where}
       ORDER BY
         FIELD(o.status, 'pending', 'read', 'archived'),
         o.created_at DESC
       LIMIT 500`,
      params
    )
    res.json({ success: true, data: (rows || []).map(mapAdminRow) })
  } catch (error) {
    console.error('[opinion-box] list', error)
    res.status(500).json({ success: false, message: '加载失败' })
  }
})

/** 管理端：更新状态 / 备注 */
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ success: false, message: '无效 ID' })

    const updates = []
    const params = []
    if (req.body?.status && ['pending', 'read', 'archived'].includes(req.body.status)) {
      updates.push('status = ?')
      params.push(req.body.status)
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'admin_note')) {
      updates.push('admin_note = ?')
      params.push(String(req.body.admin_note || '').trim() || null)
    }
    if (!updates.length) {
      return res.status(400).json({ success: false, message: '没有可更新的字段' })
    }
    params.push(id)
    await pool.query(`UPDATE opinion_box SET ${updates.join(', ')} WHERE id = ?`, params)
    res.json({ success: true, message: '已更新' })
  } catch (error) {
    console.error('[opinion-box] patch', error)
    res.status(500).json({ success: false, message: '更新失败' })
  }
})

/** 管理端：删除 */
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ success: false, message: '无效 ID' })
    await pool.query('DELETE FROM opinion_box WHERE id = ?', [id])
    res.json({ success: true, message: '已删除' })
  } catch (error) {
    console.error('[opinion-box] delete', error)
    res.status(500).json({ success: false, message: '删除失败' })
  }
})

export default router
