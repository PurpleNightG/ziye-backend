import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取所有请假记录
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        lr.*,
        DATEDIFF(lr.end_date, CURDATE()) as remaining_days
      FROM leave_records lr
      ORDER BY lr.created_at DESC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取请假记录失败:', error)
    res.status(500).json({
      success: false,
      message: '获取请假记录失败'
    })
  }
})

// 添加请假记录
router.post('/', async (req, res) => {
  try {
    const {
      member_id,
      reason,
      start_date,
      end_date,
      created_by
    } = req.body
    
    // 验证必填字段
    if (!member_id || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: '成员ID、开始日期和结束日期为必填项'
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
    
    // 计算总天数
    const [dateDiff] = await pool.query(
      'SELECT DATEDIFF(?, ?) as total_days',
      [end_date, start_date]
    )
    const total_days = dateDiff[0].total_days + 1 // 包含开始和结束日期
    
    // 插入请假记录
    const [result] = await pool.query(`
      INSERT INTO leave_records (
        member_id,
        member_name,
        qq,
        reason,
        start_date,
        end_date,
        total_days,
        status,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      member_id,
      member[0].nickname,
      member[0].qq,
      reason || '',
      start_date,
      end_date,
      total_days,
      '请假中',
      created_by || null
    ])
    
    // 更新成员状态为请假中
    await pool.query(
      'UPDATE members SET status = ? WHERE id = ?',
      ['请假中', member_id]
    )
    
    res.json({
      success: true,
      message: '请假记录添加成功',
      data: {
        id: result.insertId
      }
    })
  } catch (error) {
    console.error('添加请假记录失败:', error)
    res.status(500).json({
      success: false,
      message: '添加请假记录失败'
    })
  }
})

// 更新请假记录
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const {
      reason,
      start_date,
      end_date,
      status
    } = req.body
    
    // 检查记录是否存在
    const [existing] = await pool.query(
      'SELECT * FROM leave_records WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '请假记录不存在'
      })
    }
    
    // 计算总天数
    const [dateDiff] = await pool.query(
      'SELECT DATEDIFF(?, ?) as total_days',
      [end_date, start_date]
    )
    const total_days = dateDiff[0].total_days + 1
    
    // 更新记录
    await pool.query(`
      UPDATE leave_records SET
        reason = ?,
        start_date = ?,
        end_date = ?,
        total_days = ?,
        status = ?
      WHERE id = ?
    `, [
      reason,
      start_date,
      end_date,
      total_days,
      status,
      id
    ])
    
    // 如果状态改为已结束，更新成员状态为正常
    if (status === '已结束') {
      await pool.query(
        'UPDATE members SET status = ? WHERE id = ?',
        ['正常', existing[0].member_id]
      )
    }
    
    res.json({
      success: true,
      message: '请假记录更新成功'
    })
  } catch (error) {
    console.error('更新请假记录失败:', error)
    res.status(500).json({
      success: false,
      message: '更新请假记录失败'
    })
  }
})

// 删除请假记录
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    const [existing] = await pool.query(
      'SELECT member_id FROM leave_records WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '请假记录不存在'
      })
    }
    
    await pool.query('DELETE FROM leave_records WHERE id = ?', [id])
    
    // 检查该成员是否还有其他请假中的记录
    const [activeLeaves] = await pool.query(
      'SELECT COUNT(*) as count FROM leave_records WHERE member_id = ? AND status = ?',
      [existing[0].member_id, '请假中']
    )
    
    // 如果没有其他请假记录，将成员状态改为正常
    if (activeLeaves[0].count === 0) {
      await pool.query(
        'UPDATE members SET status = ? WHERE id = ?',
        ['正常', existing[0].member_id]
      )
    }
    
    res.json({
      success: true,
      message: '请假记录删除成功'
    })
  } catch (error) {
    console.error('删除请假记录失败:', error)
    res.status(500).json({
      success: false,
      message: '删除请假记录失败'
    })
  }
})

// 自动更新过期的请假记录
router.post('/auto-update', async (req, res) => {
  try {
    // 查找所有已过期但状态仍为请假中的记录
    const [expiredLeaves] = await pool.query(`
      SELECT id, member_id 
      FROM leave_records 
      WHERE status = '请假中' AND end_date < CURDATE()
    `)
    
    if (expiredLeaves.length > 0) {
      // 更新状态为已结束
      await pool.query(`
        UPDATE leave_records 
        SET status = '已结束' 
        WHERE status = '请假中' AND end_date < CURDATE()
      `)
      
      // 更新成员状态
      for (const leave of expiredLeaves) {
        // 检查该成员是否还有其他请假中的记录
        const [activeLeaves] = await pool.query(
          'SELECT COUNT(*) as count FROM leave_records WHERE member_id = ? AND status = ?',
          [leave.member_id, '请假中']
        )
        
        if (activeLeaves[0].count === 0) {
          await pool.query(
            'UPDATE members SET status = ? WHERE id = ?',
            ['正常', leave.member_id]
          )
        }
      }
    }
    
    res.json({
      success: true,
      message: `已更新 ${expiredLeaves.length} 条过期请假记录`
    })
  } catch (error) {
    console.error('自动更新请假记录失败:', error)
    res.status(500).json({
      success: false,
      message: '自动更新请假记录失败'
    })
  }
})

export default router
