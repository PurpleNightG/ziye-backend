import express from 'express'
import { pool } from '../config/database.js'
import jwt from 'jsonwebtoken'

const router = express.Router()

function requireStudentToken(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    res.status(401).json({ success: false, message: '未登录' })
    return null
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    if (decoded.role !== 'student' && decoded.userType !== 'student') {
      res.status(403).json({ success: false, message: '仅学员可访问' })
      return null
    }
    return decoded
  } catch {
    res.status(401).json({ success: false, message: '登录已失效' })
    return null
  }
}

// 学员获取自己的黑点记录
router.get('/my', async (req, res) => {
  try {
    const decoded = requireStudentToken(req, res)
    if (!decoded) return
    const memberId = decoded.id

    const [rows] = await pool.query(`
      SELECT * FROM black_point_records WHERE member_id = ? ORDER BY register_date DESC
    `, [memberId])
    res.json({ success: true, data: rows })
  } catch (error) {
    console.error('获取个人黑点记录失败:', error)
    res.status(500).json({ success: false, message: '获取黑点记录失败' })
  }
})

// 获取所有黑点记录
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT bp.*, m.avatar AS avatar
      FROM black_point_records bp
      LEFT JOIN members m ON m.id = bp.member_id
      WHERE m.status IS NOT NULL AND m.status != '已退队'
      ORDER BY bp.register_date DESC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取黑点记录失败:', error)
    res.status(500).json({
      success: false,
      message: '获取黑点记录失败'
    })
  }
})

// 添加黑点记录
router.post('/', async (req, res) => {
  try {
    const {
      member_id,
      reason,
      register_date,
      recorder_id,
      recorder_name
    } = req.body
    
    if (!member_id || !reason || !recorder_id) {
      return res.status(400).json({
        success: false,
        message: '成员ID、黑点原因和记录人为必填项'
      })
    }
    
    // 获取成员信息
    const [member] = await pool.query(
      'SELECT nickname, qq FROM members WHERE id = ?',
      [member_id]
    )
    
    if (member.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    // 插入黑点记录
    const [result] = await pool.query(`
      INSERT INTO black_point_records (
        member_id,
        member_name,
        qq,
        reason,
        register_date,
        recorder_id,
        recorder_name,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      member_id,
      member[0].nickname,
      member[0].qq,
      reason,
      register_date || new Date().toISOString().split('T')[0],
      recorder_id,
      recorder_name,
      '生效中'
    ])
    
    res.json({
      success: true,
      message: '黑点记录添加成功',
      data: {
        id: result.insertId
      }
    })
  } catch (error) {
    console.error('添加黑点记录失败:', error)
    res.status(500).json({
      success: false,
      message: '添加黑点记录失败'
    })
  }
})

// 更新黑点记录状态
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { status, invalid_date } = req.body
    
    const [existing] = await pool.query(
      'SELECT id FROM black_point_records WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '黑点记录不存在'
      })
    }
    
    await pool.query(`
      UPDATE black_point_records SET
        status = ?,
        invalid_date = ?
      WHERE id = ?
    `, [
      status,
      invalid_date || null,
      id
    ])
    
    res.json({
      success: true,
      message: '黑点记录更新成功'
    })
  } catch (error) {
    console.error('更新黑点记录失败:', error)
    res.status(500).json({
      success: false,
      message: '更新黑点记录失败'
    })
  }
})

// 删除黑点记录
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    const [existing] = await pool.query(
      'SELECT id FROM black_point_records WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '黑点记录不存在'
      })
    }
    
    await pool.query('DELETE FROM black_point_records WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '黑点记录删除成功'
    })
  } catch (error) {
    console.error('删除黑点记录失败:', error)
    res.status(500).json({
      success: false,
      message: '删除黑点记录失败'
    })
  }
})

export default router
