import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取系统配置
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params
    
    const [rows] = await pool.query(
      'SELECT * FROM system_settings WHERE setting_key = ?',
      [key]
    )
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '配置不存在'
      })
    }
    
    res.json({
      success: true,
      data: rows[0]
    })
  } catch (error) {
    console.error('获取系统配置失败:', error)
    res.status(500).json({
      success: false,
      message: '获取系统配置失败'
    })
  }
})

// 更新系统配置
router.put('/:key', async (req, res) => {
  try {
    const { key } = req.params
    const { value } = req.body
    
    if (value === undefined || value === null) {
      return res.status(400).json({
        success: false,
        message: '配置值不能为空'
      })
    }
    
    // 检查配置是否存在
    const [existing] = await pool.query(
      'SELECT * FROM system_settings WHERE setting_key = ?',
      [key]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '配置不存在'
      })
    }
    
    // 更新配置值
    await pool.query(
      'UPDATE system_settings SET setting_value = ? WHERE setting_key = ?',
      [value.toString(), key]
    )
    
    res.json({
      success: true,
      message: '配置更新成功'
    })
  } catch (error) {
    console.error('更新系统配置失败:', error)
    res.status(500).json({
      success: false,
      message: '更新系统配置失败'
    })
  }
})

export default router
