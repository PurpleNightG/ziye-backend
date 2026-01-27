import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取考核须知
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM assessment_guidelines
      ORDER BY id DESC
      LIMIT 1
    `)
    
    if (rows.length === 0) {
      return res.json({
        success: true,
        data: {
          id: 0,
          content: '暂无考核须知',
          updated_by: null,
          updated_at: null
        }
      })
    }
    
    res.json({
      success: true,
      data: rows[0]
    })
  } catch (error) {
    console.error('获取考核须知失败:', error)
    res.status(500).json({
      success: false,
      message: '获取考核须知失败'
    })
  }
})

// 更新考核须知（管理端）
router.put('/', async (req, res) => {
  try {
    const { content, updated_by } = req.body
    
    if (!content || content.trim() === '') {
      return res.status(400).json({
        success: false,
        message: '须知内容不能为空'
      })
    }
    
    // 检查是否已存在记录
    const [existing] = await pool.query('SELECT id FROM assessment_guidelines LIMIT 1')
    
    if (existing.length === 0) {
      // 插入新记录
      await pool.query(
        'INSERT INTO assessment_guidelines (content, updated_by) VALUES (?, ?)',
        [content, updated_by || '管理员']
      )
    } else {
      // 更新现有记录
      await pool.query(
        'UPDATE assessment_guidelines SET content = ?, updated_by = ? WHERE id = ?',
        [content, updated_by || '管理员', existing[0].id]
      )
    }
    
    res.json({
      success: true,
      message: '更新成功'
    })
  } catch (error) {
    console.error('更新考核须知失败:', error)
    res.status(500).json({
      success: false,
      message: '更新考核须知失败'
    })
  }
})

export default router
