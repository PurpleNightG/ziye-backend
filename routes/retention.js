import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取所有留队记录
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM retention_records
      ORDER BY approval_date DESC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取留队记录失败:', error)
    res.status(500).json({
      success: false,
      message: '获取留队记录失败'
    })
  }
})

// 添加留队记录
router.post('/', async (req, res) => {
  try {
    const {
      member_id,
      retention_reason,
      approver_remarks,
      approver_id,
      approver_name
    } = req.body
    
    if (!member_id || !retention_reason || !approver_id) {
      return res.status(400).json({
        success: false,
        message: '成员ID、留队原因和批准者ID为必填项'
      })
    }
    
    // 获取成员信息
    const [member] = await pool.query(
      'SELECT nickname, qq, stage_role, last_training_date FROM members WHERE id = ?',
      [member_id]
    )
    
    if (member.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    // 插入留队记录
    const [result] = await pool.query(`
      INSERT INTO retention_records (
        member_id,
        member_name,
        qq,
        stage_role,
        last_training_date,
        retention_reason,
        approver_remarks,
        approver_id,
        approver_name,
        approval_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      member_id,
      member[0].nickname,
      member[0].qq,
      member[0].stage_role,
      member[0].last_training_date,
      retention_reason,
      approver_remarks || '',
      approver_id,
      approver_name,
      new Date().toISOString().split('T')[0]
    ])
    
    // 如果成员在催促名单中，将其移除
    await pool.query(
      'DELETE FROM reminder_list WHERE member_id = ?',
      [member_id]
    )
    
    res.json({
      success: true,
      message: '留队记录添加成功',
      data: {
        id: result.insertId
      }
    })
  } catch (error) {
    console.error('添加留队记录失败:', error)
    res.status(500).json({
      success: false,
      message: '添加留队记录失败'
    })
  }
})

// 更新留队记录
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const {
      retention_reason,
      approver_remarks
    } = req.body
    
    const [existing] = await pool.query(
      'SELECT id FROM retention_records WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '留队记录不存在'
      })
    }
    
    await pool.query(`
      UPDATE retention_records SET
        retention_reason = ?,
        approver_remarks = ?
      WHERE id = ?
    `, [
      retention_reason,
      approver_remarks,
      id
    ])
    
    res.json({
      success: true,
      message: '留队记录更新成功'
    })
  } catch (error) {
    console.error('更新留队记录失败:', error)
    res.status(500).json({
      success: false,
      message: '更新留队记录失败'
    })
  }
})

// 删除留队记录
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    await pool.query('DELETE FROM retention_records WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '留队记录删除成功'
    })
  } catch (error) {
    console.error('删除留队记录失败:', error)
    res.status(500).json({
      success: false,
      message: '删除留队记录失败'
    })
  }
})

export default router
