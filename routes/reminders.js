import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取催促名单
router.get('/', async (req, res) => {
  try {
    // 从数据库获取全局超时天数设置
    const [settingRows] = await pool.query(
      'SELECT setting_value FROM system_settings WHERE setting_key = ?',
      ['reminder_timeout_days']
    )
    const defaultTimeoutDays = settingRows.length > 0 
      ? parseInt(settingRows[0].setting_value) 
      : 7
    
    const [rows] = await pool.query(`
      SELECT 
        *,
        CASE 
          WHEN custom_timeout_days IS NOT NULL THEN custom_timeout_days - days_without_training
          ELSE ? - days_without_training
        END as days_until_timeout
      FROM reminder_list
      ORDER BY days_without_training DESC
    `, [defaultTimeoutDays])
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取催促名单失败:', error)
    res.status(500).json({
      success: false,
      message: '获取催促名单失败'
    })
  }
})

// 自动更新催促名单（定时任务）
router.post('/auto-update', async (req, res) => {
  try {
    const { timeoutDays = 7 } = req.body
    
    // 定义需要检测的新训阶段
    const trainingStages = ['未新训', '新训初期', '新训一期', '新训二期', '新训三期', '新训准考']
    
    // 先保存现有的自定义超时天数设置
    const [existingSettings] = await pool.query(`
      SELECT member_id, custom_timeout_days 
      FROM reminder_list 
      WHERE custom_timeout_days IS NOT NULL
    `)
    
    // 创建一个映射表：member_id -> custom_timeout_days
    const customTimeoutMap = new Map()
    existingSettings.forEach(setting => {
      customTimeoutMap.set(setting.member_id, setting.custom_timeout_days)
    })
    
    // 获取所有符合条件的成员：
    // 1. 状态不是"已退队"、"请假中"、"其他"
    // 2. 阶段在新训范围内
    // 3. 对于未新训成员：使用加入日期判断；其他成员：使用最后新训日期判断
    // 4. 不在留队记录中
    const [members] = await pool.query(`
      SELECT 
        m.id,
        m.nickname,
        m.last_training_date,
        m.join_date,
        m.stage_role,
        CASE 
          WHEN m.last_training_date IS NOT NULL THEN DATEDIFF(CURDATE(), m.last_training_date)
          ELSE DATEDIFF(CURDATE(), m.join_date)
        END as days_without_training
      FROM members m
      LEFT JOIN retention_records r ON m.id = r.member_id
      WHERE m.status NOT IN ('已退队', '请假中', '其他')
        AND m.stage_role IN (?, ?, ?, ?, ?, ?)
        AND (
          (m.last_training_date IS NOT NULL AND DATEDIFF(CURDATE(), m.last_training_date) > ?)
          OR (m.last_training_date IS NULL AND m.join_date IS NOT NULL AND DATEDIFF(CURDATE(), m.join_date) > ?)
        )
        AND r.id IS NULL
    `, [...trainingStages, timeoutDays, timeoutDays])
    
    // 清空现有催促名单
    await pool.query('TRUNCATE TABLE reminder_list')
    
    // 插入新的催促名单，并恢复之前的自定义超时天数设置
    for (const member of members) {
      const customTimeout = customTimeoutMap.get(member.id) || null
      
      await pool.query(`
        INSERT INTO reminder_list (
          member_id,
          member_name,
          stage_role,
          last_training_date,
          days_without_training,
          custom_timeout_days
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        member.id,
        member.nickname,
        member.stage_role,
        member.last_training_date,
        member.days_without_training,
        customTimeout
      ])
    }
    
    res.json({
      success: true,
      message: `催促名单已更新，共 ${members.length} 人（超过 ${timeoutDays} 天未训练）`
    })
  } catch (error) {
    console.error('更新催促名单失败:', error)
    res.status(500).json({
      success: false,
      message: '更新催促名单失败'
    })
  }
})

// 批量更新自定义超时天数（必须在/:id/timeout之前，确保路由正确匹配）
router.put('/batch/timeout', async (req, res) => {
  try {
    const { ids, custom_timeout_days } = req.body
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请选择要修改的成员'
      })
    }
    
    // 如果为null或0，则清除自定义超时天数（使用全局设置）
    const timeoutValue = custom_timeout_days > 0 ? custom_timeout_days : null
    
    // 批量更新
    for (const id of ids) {
      await pool.query(
        'UPDATE reminder_list SET custom_timeout_days = ? WHERE id = ?',
        [timeoutValue, id]
      )
    }
    
    res.json({
      success: true,
      message: timeoutValue 
        ? `已为 ${ids.length} 个成员设置自定义超时天数为 ${timeoutValue} 天` 
        : `已为 ${ids.length} 个成员恢复使用全局超时天数设置`
    })
  } catch (error) {
    console.error('批量更新自定义超时天数失败:', error)
    res.status(500).json({
      success: false,
      message: '批量更新自定义超时天数失败'
    })
  }
})

// 更新单个成员的自定义超时天数
router.put('/:id/timeout', async (req, res) => {
  try {
    const { id } = req.params
    const { custom_timeout_days } = req.body
    
    // 如果为null或0，则清除自定义超时天数（使用全局设置）
    const timeoutValue = custom_timeout_days > 0 ? custom_timeout_days : null
    
    await pool.query(
      'UPDATE reminder_list SET custom_timeout_days = ? WHERE id = ?',
      [timeoutValue, id]
    )
    
    res.json({
      success: true,
      message: timeoutValue 
        ? `已设置自定义超时天数为 ${timeoutValue} 天` 
        : '已恢复使用全局超时天数设置'
    })
  } catch (error) {
    console.error('更新自定义超时天数失败:', error)
    res.status(500).json({
      success: false,
      message: '更新自定义超时天数失败'
    })
  }
})

// 从催促名单移除
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    await pool.query('DELETE FROM reminder_list WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '已从催促名单移除'
    })
  } catch (error) {
    console.error('移除催促名单失败:', error)
    res.status(500).json({
      success: false,
      message: '移除催促名单失败'
    })
  }
})

export default router
