import express from 'express'
import { pool } from '../config/database.js'
import bcrypt from 'bcryptjs'

const router = express.Router()

// 获取所有成员列表
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        id,
        nickname,
        qq,
        game_id,
        join_date,
        stage_role,
        status,
        last_training_date,
        remarks,
        created_at
      FROM members
      ORDER BY created_at DESC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取成员列表失败:', error)
    res.status(500).json({
      success: false,
      message: '获取成员列表失败'
    })
  }
})

// 获取单个成员信息
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const [rows] = await pool.query(
      'SELECT * FROM members WHERE id = ?',
      [id]
    )
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    res.json({
      success: true,
      data: rows[0]
    })
  } catch (error) {
    console.error('获取成员信息失败:', error)
    res.status(500).json({
      success: false,
      message: '获取成员信息失败'
    })
  }
})

// 添加新成员
router.post('/', async (req, res) => {
  try {
    const {
      nickname,
      qq,
      game_id,
      join_date,
      stage_role,
      status,
      last_training_date
    } = req.body
    
    // 验证必填字段
    if (!nickname || !qq) {
      return res.status(400).json({
        success: false,
        message: '昵称和QQ号为必填项'
      })
    }
    
    // 用户名使用昵称，密码默认为QQ号
    const username = nickname
    const password = qq
    
    // 检查用户名或QQ是否已存在
    const [existing] = await pool.query(
      'SELECT id FROM members WHERE username = ? OR qq = ?',
      [username, qq]
    )
    
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: '昵称或QQ号已存在'
      })
    }
    
    // 加密密码（使用QQ号）
    const hashedPassword = await bcrypt.hash(password, 10)
    
    // 插入数据库
    const [result] = await pool.query(`
      INSERT INTO members (
        username,
        password,
        nickname,
        qq,
        game_id,
        join_date,
        stage_role,
        status,
        last_training_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      username,
      hashedPassword,
      nickname,
      qq,
      game_id || null,
      join_date || new Date(),
      stage_role || '未新训',
      status || '正常',
      last_training_date || null
    ])
    
    res.json({
      success: true,
      message: '成员添加成功',
      data: {
        id: result.insertId
      }
    })
  } catch (error) {
    console.error('添加成员失败:', error)
    res.status(500).json({
      success: false,
      message: '添加成员失败'
    })
  }
})

// 更新成员信息
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const {
      nickname,
      qq,
      game_id,
      join_date,
      stage_role,
      status,
      last_training_date,
      remarks
    } = req.body
    
    // 检查成员是否存在
    const [existing] = await pool.query(
      'SELECT id FROM members WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    // 更新数据
    await pool.query(`
      UPDATE members SET
        nickname = ?,
        qq = ?,
        game_id = ?,
        join_date = ?,
        stage_role = ?,
        status = ?,
        last_training_date = ?,
        remarks = ?
      WHERE id = ?
    `, [
      nickname,
      qq,
      game_id,
      join_date,
      stage_role,
      status,
      last_training_date,
      remarks || null,
      id
    ])
    
    res.json({
      success: true,
      message: '成员信息更新成功'
    })
  } catch (error) {
    console.error('更新成员信息失败:', error)
    res.status(500).json({
      success: false,
      message: '更新成员信息失败'
    })
  }
})

// 删除成员
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    // 检查成员是否存在
    const [existing] = await pool.query(
      'SELECT id FROM members WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    // 删除成员
    await pool.query('DELETE FROM members WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '成员删除成功'
    })
  } catch (error) {
    console.error('删除成员失败:', error)
    res.status(500).json({
      success: false,
      message: '删除成员失败'
    })
  }
})

// 重置单个成员密码为QQ号
router.put('/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params
    
    // 获取成员QQ号
    const [members] = await pool.query(
      'SELECT qq, nickname FROM members WHERE id = ?',
      [id]
    )
    
    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    const { qq, nickname } = members[0]
    
    // 将密码重置为QQ号
    const hashedPassword = await bcrypt.hash(qq, 10)
    
    await pool.query(
      'UPDATE members SET password = ? WHERE id = ?',
      [hashedPassword, id]
    )
    
    res.json({
      success: true,
      message: `已将 ${nickname} 的密码重置为QQ号`
    })
  } catch (error) {
    console.error('重置密码失败:', error)
    res.status(500).json({
      success: false,
      message: '重置密码失败'
    })
  }
})

// 批量重置密码为QQ号
router.put('/batch/reset-password', async (req, res) => {
  try {
    const { ids } = req.body
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请选择要重置密码的成员'
      })
    }
    
    // 批量重置
    for (const id of ids) {
      const [members] = await pool.query(
        'SELECT qq FROM members WHERE id = ?',
        [id]
      )
      
      if (members.length > 0) {
        const { qq } = members[0]
        const hashedPassword = await bcrypt.hash(qq, 10)
        
        await pool.query(
          'UPDATE members SET password = ? WHERE id = ?',
          [hashedPassword, id]
        )
      }
    }
    
    res.json({
      success: true,
      message: `已为 ${ids.length} 个成员重置密码为QQ号`
    })
  } catch (error) {
    console.error('批量重置密码失败:', error)
    res.status(500).json({
      success: false,
      message: '批量重置密码失败'
    })
  }
})

export default router
