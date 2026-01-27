import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 格式化日期为YYYY-MM-DD
function formatDate(dateString) {
  if (!dateString) return null
  const date = new Date(dateString)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 生成准考证号
function generateAdmissionTicket(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `PNG${year}${month}${day}${random}`
}

// 获取所有申请（管理端）
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM assessment_applications
      ORDER BY created_at DESC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取申请列表失败:', error)
    res.status(500).json({
      success: false,
      message: '获取申请列表失败'
    })
  }
})

// 根据学员ID获取申请（学员端）
router.get('/member/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params
    
    const [rows] = await pool.query(`
      SELECT * FROM assessment_applications
      WHERE member_id = ?
      ORDER BY created_at DESC
    `, [memberId])
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取学员申请失败:', error)
    res.status(500).json({
      success: false,
      message: '获取学员申请失败'
    })
  }
})

// 创建申请（学员端）
router.post('/', async (req, res) => {
  try {
    const {
      member_id,
      member_name,
      companion,
      preferred_date,
      preferred_time
    } = req.body
    
    // 验证必填字段
    if (!member_id || !member_name || !companion || !preferred_date || !preferred_time) {
      return res.status(400).json({
        success: false,
        message: '缺少必填字段'
      })
    }
    
    // 检查该学员是否已有待审批的申请
    const [existing] = await pool.query(
      'SELECT id FROM assessment_applications WHERE member_id = ? AND status = ?',
      [member_id, '待审批']
    )
    
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: '您已有待审批的申请，请等待审批完成后再提交新申请'
      })
    }
    
    const [result] = await pool.query(
      `INSERT INTO assessment_applications 
      (member_id, member_name, companion, preferred_date, preferred_time, status) 
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        member_id,
        member_name,
        companion,
        formatDate(preferred_date),
        preferred_time,
        '待审批'
      ]
    )
    
    res.json({
      success: true,
      message: '申请提交成功',
      data: { id: result.insertId }
    })
  } catch (error) {
    console.error('创建申请失败:', error)
    res.status(500).json({
      success: false,
      message: '创建申请失败'
    })
  }
})

// 审批申请（管理端）
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params
    const { approved_by } = req.body
    
    // 获取申请信息
    const [applications] = await pool.query(
      'SELECT * FROM assessment_applications WHERE id = ?',
      [id]
    )
    
    if (applications.length === 0) {
      return res.status(404).json({
        success: false,
        message: '申请不存在'
      })
    }
    
    const application = applications[0]
    
    if (application.status !== '待审批') {
      return res.status(400).json({
        success: false,
        message: '该申请已处理'
      })
    }
    
    // 生成准考证号
    const admission_ticket = generateAdmissionTicket(new Date(application.preferred_date))
    
    await pool.query(
      `UPDATE assessment_applications 
      SET status = ?, admission_ticket = ?, approved_by = ?, approved_at = NOW()
      WHERE id = ?`,
      ['已通过', admission_ticket, approved_by || '管理员', id]
    )
    
    res.json({
      success: true,
      message: '审批通过',
      data: { admission_ticket }
    })
  } catch (error) {
    console.error('审批失败:', error)
    res.status(500).json({
      success: false,
      message: '审批失败'
    })
  }
})

// 驳回申请（管理端）
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params
    const { reject_reason, approved_by } = req.body
    
    if (!reject_reason || reject_reason.trim() === '') {
      return res.status(400).json({
        success: false,
        message: '请填写驳回理由'
      })
    }
    
    // 获取申请信息
    const [applications] = await pool.query(
      'SELECT status FROM assessment_applications WHERE id = ?',
      [id]
    )
    
    if (applications.length === 0) {
      return res.status(404).json({
        success: false,
        message: '申请不存在'
      })
    }
    
    if (applications[0].status !== '待审批') {
      return res.status(400).json({
        success: false,
        message: '该申请已处理'
      })
    }
    
    await pool.query(
      `UPDATE assessment_applications 
      SET status = ?, reject_reason = ?, approved_by = ?, approved_at = NOW()
      WHERE id = ?`,
      ['已驳回', reject_reason, approved_by || '管理员', id]
    )
    
    res.json({
      success: true,
      message: '已驳回申请'
    })
  } catch (error) {
    console.error('驳回失败:', error)
    res.status(500).json({
      success: false,
      message: '驳回失败'
    })
  }
})

// 删除申请
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    await pool.query('DELETE FROM assessment_applications WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '删除成功'
    })
  } catch (error) {
    console.error('删除申请失败:', error)
    res.status(500).json({
      success: false,
      message: '删除申请失败'
    })
  }
})

export default router
