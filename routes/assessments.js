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

// 计算评级
function calculateRating(score) {
  if (score >= 100) return '完美'
  if (score >= 90) return '优秀'
  if (score >= 70) return '良好'
  if (score >= 60) return '合格'
  return '不合格'
}

// 获取所有考核记录
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM assessments
      ORDER BY assessment_date DESC, created_at DESC
    `)
    
    // 解析JSON字段
    const assessments = rows.map(row => {
      let deduction_records = []
      try {
        if (row.deduction_records) {
          if (typeof row.deduction_records === 'string' && row.deduction_records.trim() !== '') {
            deduction_records = JSON.parse(row.deduction_records)
          } else if (Array.isArray(row.deduction_records)) {
            deduction_records = row.deduction_records
          }
        }
      } catch (e) {
        console.warn('解析deduction_records失败:', e.message)
      }
      return {
        ...row,
        deduction_records
      }
    })
    
    res.json({
      success: true,
      data: assessments
    })
  } catch (error) {
    console.error('获取考核记录失败:', error)
    res.status(500).json({
      success: false,
      message: '获取考核记录失败'
    })
  }
})

// 根据学员ID获取考核记录
router.get('/member/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params
    
    const [rows] = await pool.query(`
      SELECT * FROM assessments
      WHERE member_id = ?
      ORDER BY assessment_date DESC, created_at DESC
    `, [memberId])
    
    // 解析JSON字段
    const assessments = rows.map(row => {
      let deduction_records = []
      try {
        if (row.deduction_records) {
          if (typeof row.deduction_records === 'string' && row.deduction_records.trim() !== '') {
            deduction_records = JSON.parse(row.deduction_records)
          } else if (Array.isArray(row.deduction_records)) {
            deduction_records = row.deduction_records
          }
        }
      } catch (e) {
        console.warn('解析deduction_records失败:', e.message)
      }
      return {
        ...row,
        deduction_records
      }
    })
    
    res.json({
      success: true,
      data: assessments
    })
  } catch (error) {
    console.error('获取学员考核记录失败:', error)
    res.status(500).json({
      success: false,
      message: '获取学员考核记录失败'
    })
  }
})

// 创建考核记录
router.post('/', async (req, res) => {
  try {
    const {
      member_id,
      member_name,
      assessment_date,
      status,
      map,
      custom_map,
      evaluation,
      deduction_records,
      video_url
    } = req.body
    
    // 验证必填字段
    if (!member_id || !member_name || !assessment_date || !map) {
      return res.status(400).json({
        success: false,
        message: '缺少必填字段'
      })
    }
    
    // 先过滤掉空的扣分记录（没有code的）
    const validDeductionRecords = deduction_records && Array.isArray(deduction_records)
      ? deduction_records.filter(r => r.code && r.code.trim() !== '')
      : []
    
    // 用过滤后的记录计算总分
    let total_score = 100
    if (validDeductionRecords.length > 0) {
      const totalDeduction = validDeductionRecords.reduce((sum, record) => sum + (record.score || 0), 0)
      total_score = Math.max(0, 100 - totalDeduction)
    }
    
    // 计算评级
    const rating = calculateRating(total_score)
    
    // 判断是否已填写（确保返回布尔值）
    const has_evaluation = !!(evaluation && evaluation.trim() !== '')
    const has_deduction_records = validDeductionRecords.length > 0
    const has_video = !!(video_url && video_url.trim() !== '')
    
    // 自动生成iframe代码
    const auto_iframe = has_video 
      ? `<iframe width="640" height="360" src="${video_url}" frameborder="0" scrolling="no" allowfullscreen></iframe>`
      : null
    
    const [result] = await pool.query(
      `INSERT INTO assessments 
      (member_id, member_name, assessment_date, status, map, custom_map, 
       evaluation, deduction_records, total_score, rating, 
       has_evaluation, has_deduction_records, video_url, video_iframe, has_video) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member_id,
        member_name,
        formatDate(assessment_date),
        status || '待处理',
        map,
        custom_map,
        evaluation,
        validDeductionRecords.length > 0 ? JSON.stringify(validDeductionRecords) : null,
        total_score,
        rating,
        has_evaluation,
        has_deduction_records,
        video_url || null,
        auto_iframe,
        has_video
      ]
    )
    
    res.json({
      success: true,
      message: '考核记录创建成功',
      data: { id: result.insertId }
    })
  } catch (error) {
    console.error('创建考核记录失败:', error)
    res.status(500).json({
      success: false,
      message: '创建考核记录失败'
    })
  }
})

// 更新考核记录
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const {
      member_id,
      member_name,
      assessment_date,
      status,
      map,
      custom_map,
      evaluation,
      deduction_records,
      video_url
    } = req.body
    
    // 先过滤掉空的扣分记录（没有code的）
    const validDeductionRecords = deduction_records && Array.isArray(deduction_records)
      ? deduction_records.filter(r => r.code && r.code.trim() !== '')
      : []
    
    // 用过滤后的记录计算总分
    let total_score = 100
    if (validDeductionRecords.length > 0) {
      const totalDeduction = validDeductionRecords.reduce((sum, record) => sum + (record.score || 0), 0)
      total_score = Math.max(0, 100 - totalDeduction)
    }
    
    // 计算评级
    const rating = calculateRating(total_score)
    
    // 判断是否已填写（确保返回布尔值）
    const has_evaluation = !!(evaluation && evaluation.trim() !== '')
    const has_deduction_records = validDeductionRecords.length > 0
    const has_video = !!(video_url && video_url.trim() !== '')
    
    // 自动生成iframe代码
    const auto_iframe = has_video 
      ? `<iframe width="640" height="360" src="${video_url}" frameborder="0" scrolling="no" allowfullscreen></iframe>`
      : null
    
    await pool.query(
      `UPDATE assessments 
      SET member_id = ?, member_name = ?, assessment_date = ?, status = ?, 
          map = ?, custom_map = ?, evaluation = ?, deduction_records = ?, 
          total_score = ?, rating = ?, has_evaluation = ?, has_deduction_records = ?,
          video_url = ?, video_iframe = ?, has_video = ?
      WHERE id = ?`,
      [
        member_id,
        member_name,
        formatDate(assessment_date),
        status,
        map,
        custom_map,
        evaluation,
        validDeductionRecords.length > 0 ? JSON.stringify(validDeductionRecords) : null,
        total_score,
        rating,
        has_evaluation,
        has_deduction_records,
        video_url || null,
        auto_iframe,
        has_video,
        id
      ]
    )
    
    res.json({
      success: true,
      message: '考核记录更新成功'
    })
  } catch (error) {
    console.error('更新考核记录失败:', error)
    res.status(500).json({
      success: false,
      message: '更新考核记录失败'
    })
  }
})

// 删除考核记录
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    await pool.query('DELETE FROM assessments WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '考核记录删除成功'
    })
  } catch (error) {
    console.error('删除考核记录失败:', error)
    res.status(500).json({
      success: false,
      message: '删除考核记录失败'
    })
  }
})

// 批量删除考核记录
router.post('/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: '无效的ID列表'
      })
    }
    
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(
      `DELETE FROM assessments WHERE id IN (${placeholders})`,
      ids
    )
    
    res.json({
      success: true,
      message: `已删除 ${ids.length} 条考核记录`
    })
  } catch (error) {
    console.error('批量删除考核记录失败:', error)
    res.status(500).json({
      success: false,
      message: '批量删除考核记录失败'
    })
  }
})

export default router
