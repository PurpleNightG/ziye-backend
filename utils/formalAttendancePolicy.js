/**
 * 正式队员短周期考勤策略（阶段列表来自 reminder_rules_config.training.formalStages）
 */
import { pool } from '../config/database.js'
import { getSetting } from '../routes/settings.js'
import { loadReminderRulesConfig } from './reminderRulesConfig.js'

export const FORMAL_MEMBER_STAGES = ['紫夜', '紫夜尖兵']

export async function ensureFormalUse180Table() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminder_formal_use_180 (
      member_id INT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      note VARCHAR(64) NULL COMMENT '取消考勤：改用180天'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export async function loadFormalUse180Set() {
  try {
    await ensureFormalUse180Table()
    const [rows] = await pool.query('SELECT member_id FROM reminder_formal_use_180')
    return new Set(rows.map((r) => Number(r.member_id)))
  } catch (e) {
    console.error('[formalAttendance] load use180 set', e.message)
    return new Set()
  }
}

/** @returns {Promise<number>} 0 表示未启用正式队员短周期考勤 */
export async function loadFormalTimeoutDays() {
  try {
    const cfg = await loadReminderRulesConfig()
    return cfg.training.formalTimeoutDays || 0
  } catch {
    const row = await getSetting('reminder_formal_timeout_days', '0')
    const n = parseInt(row.setting_value, 10)
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.min(365, n)
  }
}

export async function loadFormalAttendancePolicy() {
  const cfg = await loadReminderRulesConfig()
  const use180Set = await loadFormalUse180Set()
  return {
    formalTimeoutDays: cfg.training.formalTimeoutDays || 0,
    formalStages: cfg.training.formalStages || [...FORMAL_MEMBER_STAGES],
    use180Set,
    rulesConfig: cfg,
  }
}

export function isFormalMemberStage(stage, formalStages = FORMAL_MEMBER_STAGES) {
  return Array.isArray(formalStages) && formalStages.includes(stage)
}

/** 是否对该成员启用考勤里的 training_idle（短周期开启且未取消考勤时为 false） */
export function shouldApplyFormalIdle(stage, formalTimeoutDays, useFormal180, formalStages = FORMAL_MEMBER_STAGES) {
  if (!isFormalMemberStage(stage, formalStages)) return false
  if (formalTimeoutDays > 0 && !useFormal180) return false
  return true
}
