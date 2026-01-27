import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取所有退队审批
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM quit_approvals
      ORDER BY apply_date DESC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取退队审批失败:', error)
    res.status(500).json({
      success: false,
      message: '获取退队审批失败'
    })
  }
})

// 添加退队审批（手动）
router.post('/', async (req, res) => {
  try {
    const {
      member_id,
      source_admin_id,
      source_admin_name,
      remarks
    } = req.body
    
    if (!member_id || !source_admin_id) {
      return res.status(400).json({
        success: false,
        message: '成员ID和管理员ID为必填项'
      })
    }
    
    // 检查该成员是否已有待审批的退队记录
    const [existing] = await pool.query(
      'SELECT id FROM quit_approvals WHERE member_id = ? AND status = ?',
      [member_id, '待审批']
    )
    
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: '该成员已有待审批的退队记录，不能重复添加'
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
    
    // 插入退队审批
    const [result] = await pool.query(`
      INSERT INTO quit_approvals (
        member_id,
        member_name,
        qq,
        apply_date,
        source_type,
        source_admin_id,
        source_admin_name,
        status,
        remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      member_id,
      member[0].nickname,
      member[0].qq,
      new Date().toISOString().split('T')[0],
      '手动',
      source_admin_id,
      source_admin_name,
      '待审批',
      remarks || ''
    ])
    
    res.json({
      success: true,
      message: '退队审批添加成功',
      data: {
        id: result.insertId
      }
    })
  } catch (error) {
    console.error('添加退队审批失败:', error)
    res.status(500).json({
      success: false,
      message: '添加退队审批失败'
    })
  }
})

// 审批退队申请
router.put('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params
    const {
      approver_id,
      approver_name,
      status,
      remarks
    } = req.body
    
    if (!approver_id || !status) {
      return res.status(400).json({
        success: false,
        message: '审批人ID和审批状态为必填项'
      })
    }
    
    // 获取退队审批信息
    const [approval] = await pool.query(
      'SELECT * FROM quit_approvals WHERE id = ?',
      [id]
    )
    
    if (approval.length === 0) {
      return res.status(404).json({
        success: false,
        message: '退队审批不存在'
      })
    }
    
    // 更新审批状态
    await pool.query(`
      UPDATE quit_approvals SET
        status = ?,
        approver_id = ?,
        approver_name = ?,
        approval_date = ?,
        remarks = ?
      WHERE id = ?
    `, [
      status,
      approver_id,
      approver_name,
      new Date().toISOString().split('T')[0],
      remarks || approval[0].remarks,
      id
    ])
    
    // 如果批准，更新成员状态为已退队
    if (status === '已批准') {
      await pool.query(
        'UPDATE members SET status = ? WHERE id = ?',
        ['已退队', approval[0].member_id]
      )
    }
    
    res.json({
      success: true,
      message: '审批完成'
    })
  } catch (error) {
    console.error('审批退队失败:', error)
    res.status(500).json({
      success: false,
      message: '审批退队失败'
    })
  }
})

// 删除退队审批
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    await pool.query('DELETE FROM quit_approvals WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '退队审批删除成功'
    })
  } catch (error) {
    console.error('删除退队审批失败:', error)
    res.status(500).json({
      success: false,
      message: '删除退队审批失败'
    })
  }
})

// 从催促名单自动生成退队审批
router.post('/auto-generate', async (req, res) => {
  try {
    // 查找超过30天未训练的成员
    const [members] = await pool.query(`
      SELECT * FROM reminder_list
      WHERE days_without_training > 30
    `)
    
    let count = 0
    for (const member of members) {
      // 检查是否已有待审批的退队记录
      const [existing] = await pool.query(
        'SELECT id FROM quit_approvals WHERE member_id = ? AND status = ?',
        [member.member_id, '待审批']
      )
      
      if (existing.length === 0) {
        // 创建自动退队审批
        await pool.query(`
          INSERT INTO quit_approvals (
            member_id,
            member_name,
            qq,
            apply_date,
            source_type,
            status,
            remarks
          ) SELECT 
            m.id,
            m.nickname,
            m.qq,
            CURDATE(),
            '自动',
            '待审批',
            CONCAT('长期未训练（', ?, '天）')
          FROM members m
          WHERE m.id = ?
        `, [member.days_without_training, member.member_id])
        
        count++
      }
    }
    
    res.json({
      success: true,
      message: `已自动生成 ${count} 条退队审批`
    })
  } catch (error) {
    console.error('自动生成退队审批失败:', error)
    res.status(500).json({
      success: false,
      message: '自动生成退队审批失败'
    })
  }
})

export default router
