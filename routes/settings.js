import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

const SETTING_CACHE_TTL_MS = 5 * 60_000
const settingCache = new Map()

/** 读取配置；不存在时用 defaultValue 并写入 */
export async function getSetting(key, defaultValue = null) {
  const cached = settingCache.get(key)
  if (cached && Date.now() - cached.at < SETTING_CACHE_TTL_MS) {
    return cached.row
  }
  const [rows] = await pool.query(
    'SELECT * FROM system_settings WHERE setting_key = ?',
    [key]
  )
  if (rows.length > 0) {
    settingCache.set(key, { at: Date.now(), row: rows[0] })
    return rows[0]
  }
  if (defaultValue === null || defaultValue === undefined) return null
  await pool.query(
    `INSERT INTO system_settings (setting_key, setting_value, description)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = setting_value`,
    [key, String(defaultValue), '']
  )
  const row = { setting_key: key, setting_value: String(defaultValue) }
  settingCache.set(key, { at: Date.now(), row })
  return row
}

export async function upsertSetting(key, value, description = '') {
  await pool.query(
    `INSERT INTO system_settings (setting_key, setting_value, description)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, String(value), description]
  )
  settingCache.delete(key)
}

// 获取系统配置
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params
    const defaults = {
      reminder_timeout_days: '7',
      reminder_kick_weekday: '1',
      reminder_kick_lead_days: '3',
      reminder_display_mode: 'remaining',
    }
    const row = await getSetting(key, defaults[key] ?? null)
    if (!row) {
      return res.status(404).json({
        success: false,
        message: '配置不存在'
      })
    }
    res.json({ success: true, data: row })
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

    const descriptions = {
      reminder_timeout_days: '催促名单全局超时天数设置',
      reminder_formal_timeout_days: '正式队员（紫夜/尖兵）训练催促天数，0=关闭改走180天考勤',
      reminder_rules_config: '催促/考勤规则总配置 JSON',
      reminder_kick_weekday: '踢人日（1=周一…7=周日）',
      reminder_kick_lead_days: '踢人提前提醒天数',
      reminder_display_mode: '催促名单显示模式 remaining|kick_cycle',
    }

    await upsertSetting(key, value, descriptions[key] || '')

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
