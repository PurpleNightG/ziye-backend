import express from 'express'
import { pool } from '../config/database.js'
import { TRAINING_STAGES, TRAINING_WARN_DAYS } from '../utils/reminderQuery.js'
import { computeAttendanceForMember, ATTENDANCE_WARN_DAYS } from '../utils/attendanceReminder.js'
import {
  loadReminderConfig,
  queryTrainingReminders,
  queryTrainingReminderForMember,
} from '../utils/trainingReminderList.js'
import {
  ensureFormalUse180Table,
  isFormalMemberStage,
  loadFormalAttendancePolicy,
} from '../utils/formalAttendancePolicy.js'
import {
  ALL_MEMBER_STAGES,
  getDefaultReminderRulesConfig,
  loadReminderRulesConfig,
  saveReminderRulesConfig,
} from '../utils/reminderRulesConfig.js'
import { authenticateRequest } from '../utils/authGate.js'

const router = express.Router()

async function requireStudentSelf(req, res, memberId) {
  const auth = await authenticateRequest(req, { requireType: 'student' })
  if (!auth) {
    res.status(401).json({ success: false, message: '未登录或会话已失效，请重新登录' })
    return null
  }
  if (Number(auth.userId) !== Number(memberId)) {
    res.status(403).json({ success: false, message: '只能查看自己的数据' })
    return null
  }
  return auth
}

export async function ensureAttendanceOverrideTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_reminder_overrides (
      id INT PRIMARY KEY AUTO_INCREMENT,
      member_id INT NOT NULL,
      reason_code VARCHAR(32) NOT NULL COMMENT 'to_phase3|to_exam|to_formal|formal_idle',
      custom_deadline_days INT NOT NULL COMMENT '绝对期限天数（已过+希望还剩）',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_member_reason (member_id, reason_code),
      INDEX idx_aro_member (member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export async function loadAttendanceContext() {
  const [members] = await pool.query(`
    SELECT
      m.id, m.nickname, m.qq, m.stage_role, m.status,
      m.join_date, m.last_training_date, m.phase3_reached_at,
      m.avatar,
      CASE WHEN ret.id IS NOT NULL THEN 1 ELSE 0 END AS in_retention
    FROM members m
    LEFT JOIN retention_records ret ON m.id = ret.member_id
    WHERE m.status != '已退队'
  `)

  const [leaves] = await pool.query(`
    SELECT member_id, start_date, end_date, status
    FROM leave_records
    WHERE status IN ('请假中', '待结束审批', '已结束')
  `)

  const leaveMap = new Map()
  for (const row of leaves) {
    if (!leaveMap.has(row.member_id)) leaveMap.set(row.member_id, [])
    leaveMap.get(row.member_id).push(row)
  }

  const [ignores] = await pool.query('SELECT member_id FROM attendance_reminder_ignores')
  const ignoreSet = new Set(ignores.map(r => r.member_id))

  let overrideMap = new Map()
  try {
    await ensureAttendanceOverrideTable()
    const [overrides] = await pool.query(
      'SELECT member_id, reason_code, custom_deadline_days FROM attendance_reminder_overrides'
    )
    for (const row of overrides) {
      if (!overrideMap.has(row.member_id)) overrideMap.set(row.member_id, {})
      overrideMap.get(row.member_id)[row.reason_code] = Number(row.custom_deadline_days)
    }
  } catch (e) {
    console.error('[reminders] load attendance overrides', e.message)
    overrideMap = new Map()
  }

  const policy = await loadFormalAttendancePolicy()

  return {
    members,
    leaveMap,
    ignoreSet,
    overrideMap,
    formalTimeoutDays: policy.formalTimeoutDays,
    formalStages: policy.formalStages,
    use180Set: policy.use180Set,
    rulesConfig: policy.rulesConfig,
  }
}

export function buildAttendanceList(ctx, { showAll = false, memberId = null } = {}) {
  const {
    members,
    leaveMap,
    ignoreSet,
    overrideMap,
    formalTimeoutDays = 0,
    use180Set = new Set(),
    rulesConfig = null,
  } = ctx
  const list = []
  for (const m of members) {
    if (memberId != null && m.id !== memberId) continue
    const item = computeAttendanceForMember(
      m,
      leaveMap.get(m.id) || [],
      {
        ignored: ignoreSet.has(m.id),
        inRetention: !!m.in_retention,
        showAll: showAll || memberId != null,
        overrides: overrideMap.get(m.id) || {},
        formalTimeoutDays,
        useFormal180: use180Set.has(Number(m.id)),
        rulesConfig,
      }
    )
    if (item) list.push(item)
  }
  list.sort((a, b) => a.remaining_days - b.remaining_days)
  return list
}

/** 催促/考勤规则总配置 */
router.get('/rules-config', async (_req, res) => {
  try {
    const config = await loadReminderRulesConfig()
    res.json({
      success: true,
      data: config,
      meta: {
        allStages: ALL_MEMBER_STAGES,
        defaults: getDefaultReminderRulesConfig(),
      },
    })
  } catch (error) {
    console.error('获取规则配置失败:', error)
    res.status(500).json({ success: false, message: '获取规则配置失败' })
  }
})

router.put('/rules-config', async (req, res) => {
  try {
    const config = await saveReminderRulesConfig(req.body?.config ?? req.body)
    res.json({ success: true, data: config, message: '规则配置已保存' })
  } catch (error) {
    console.error('保存规则配置失败:', error)
    res.status(500).json({ success: false, message: '保存规则配置失败' })
  }
})

// 进度催促名单（升期/闲置规则链）
router.get('/attendance', async (req, res) => {
  try {
    const showAll = req.query.showAll === '1' || req.query.showAll === 'true'
    const ctx = await loadAttendanceContext()
    const data = buildAttendanceList(ctx, { showAll })
    res.json({
      success: true,
      data,
      meta: {
        showAll,
        warnDays: ctx.rulesConfig?.attendance?.warnDays ?? ATTENDANCE_WARN_DAYS,
        total: data.length,
        formalTimeoutDays: ctx.formalTimeoutDays || 0,
      },
    })
  } catch (error) {
    console.error('获取进度催促失败:', error)
    res.status(500).json({ success: false, message: '获取进度催促失败' })
  }
})

// 学员端：自己的考勤倒计时
router.get('/attendance/me/:memberId', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10)
    if (!memberId) {
      return res.status(400).json({ success: false, message: '无效的成员ID' })
    }
    if (!(await requireStudentSelf(req, res, memberId))) return
    const ctx = await loadAttendanceContext()
    const data = buildAttendanceList(ctx, { showAll: true, memberId })
    res.json({ success: true, data: data[0] || null })
  } catch (error) {
    console.error('获取学员进度催促失败:', error)
    res.status(500).json({ success: false, message: '获取进度催促失败' })
  }
})

// 学员端：是否出现在管理端「训练催促」名单（按倒计时预警规则，含自定义延期）
router.get('/training/me/:memberId', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10)
    if (!memberId) {
      return res.status(400).json({ success: false, message: '无效的成员ID' })
    }
    if (!(await requireStudentSelf(req, res, memberId))) return
    const cfg = await loadReminderConfig()
    // 学员始终按倒计时；正式队员开启短周期考勤时，即便未进管理端预警窗也返回倒计时
    const warnDays = cfg.trainingWarnDays ?? TRAINING_WARN_DAYS
    const item = await queryTrainingReminderForMember(
      memberId,
      cfg.defaultTimeoutDays,
      warnDays,
      { formalTimeoutDays: cfg.formalTimeoutDays }
    )
    res.json({
      success: true,
      data: item,
      meta: {
        timeoutDays: cfg.defaultTimeoutDays,
        formalTimeoutDays: cfg.formalTimeoutDays,
        warnDays,
      },
    })
  } catch (error) {
    console.error('获取学员训练催促失败:', error)
    res.status(500).json({ success: false, message: '获取训练催促失败' })
  }
})

// 忽略某人的考勤倒计时
router.post('/attendance/ignore/:memberId', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10)
    const ignoredBy = req.body?.ignored_by || null
    await pool.query(
      `INSERT INTO attendance_reminder_ignores (member_id, ignored_by)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE ignored_by = VALUES(ignored_by), ignored_at = CURRENT_TIMESTAMP`,
      [memberId, ignoredBy]
    )
    res.json({ success: true, message: '已忽略该成员的考勤倒计时' })
  } catch (error) {
    console.error('忽略进度催促失败:', error)
    res.status(500).json({ success: false, message: '忽略失败' })
  }
})

// 取消忽略
router.delete('/attendance/ignore/:memberId', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10)
    await pool.query('DELETE FROM attendance_reminder_ignores WHERE member_id = ?', [memberId])
    res.json({ success: true, message: '已恢复该成员的考勤倒计时' })
  } catch (error) {
    console.error('取消忽略进度催促失败:', error)
    res.status(500).json({ success: false, message: '取消忽略失败' })
  }
})

/** 正式队员取消短周期考勤 → 改用 180 天进度催促 */
router.post('/formal/:memberId/use-180', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10)
    if (!memberId) {
      return res.status(400).json({ success: false, message: '无效成员' })
    }
    const [[member]] = await pool.query('SELECT id, stage_role FROM members WHERE id = ?', [memberId])
    if (!member) {
      return res.status(404).json({ success: false, message: '成员不存在' })
    }
    const policy = await loadFormalAttendancePolicy()
    if (!isFormalMemberStage(member.stage_role, policy.formalStages)) {
      return res.status(400).json({
        success: false,
        message: `仅「${(policy.formalStages || []).join(' / ') || '正式队员'}」可取消考勤`,
      })
    }
    if (!(policy.formalTimeoutDays > 0)) {
      return res.status(400).json({ success: false, message: '请先在规则设置中填写正式队员考勤时间' })
    }
    await ensureFormalUse180Table()
    await pool.query(
      `INSERT INTO reminder_formal_use_180 (member_id, note)
       VALUES (?, '取消考勤')
       ON DUPLICATE KEY UPDATE note = VALUES(note)`,
      [memberId]
    )
    res.json({ success: true, message: '已取消考勤，该成员改按 180 天计入进度催促' })
  } catch (error) {
    console.error('正式队员取消考勤失败:', error)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/** 恢复正式队员短周期考勤（从 180 天回到训练催促） */
router.delete('/formal/:memberId/use-180', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10)
    if (!memberId) {
      return res.status(400).json({ success: false, message: '无效成员' })
    }
    await ensureFormalUse180Table()
    await pool.query('DELETE FROM reminder_formal_use_180 WHERE member_id = ?', [memberId])
    res.json({ success: true, message: '已恢复正式队员考勤，该成员改走训练催促' })
  } catch (error) {
    console.error('恢复正式队员考勤失败:', error)
    res.status(500).json({ success: false, message: '操作失败' })
  }
})

/**
 * 批量设置考勤「希望还剩几天」
 * body: { member_ids: number[], remaining_days: number | null }
 */
router.put('/attendance/batch/timeout', async (req, res) => {
  try {
    await ensureAttendanceOverrideTable()
    const memberIds = Array.isArray(req.body?.member_ids)
      ? req.body.member_ids.map((id) => Number(id)).filter((id) => id > 0)
      : []
    if (!memberIds.length) {
      return res.status(400).json({ success: false, message: '请选择成员' })
    }

    const remainingRaw = req.body?.remaining_days
    const clear = remainingRaw === null || remainingRaw === '' || typeof remainingRaw === 'undefined'
    const remainingDays = clear ? null : Math.max(0, parseInt(remainingRaw, 10) || 0)

    if (clear) {
      await pool.query(
        `DELETE FROM attendance_reminder_overrides WHERE member_id IN (${memberIds.map(() => '?').join(',')})`,
        memberIds
      )
      return res.json({ success: true, message: `已为 ${memberIds.length} 人恢复默认考勤期限` })
    }

    const ctx = await loadAttendanceContext()
    let updated = 0
    for (const mid of memberIds) {
      const member = ctx.members.find((m) => m.id === mid)
      if (!member) continue
      const item = computeAttendanceForMember(member, ctx.leaveMap.get(mid) || [], {
        ignored: false,
        inRetention: !!member.in_retention,
        showAll: true,
        overrides: {},
        formalTimeoutDays: ctx.formalTimeoutDays || 0,
        useFormal180: ctx.use180Set?.has(Number(mid)),
        rulesConfig: ctx.rulesConfig,
      })
      if (!item) continue
      const customDeadline = Math.max(1, item.elapsed_days + remainingDays)
      await pool.query(
        `INSERT INTO attendance_reminder_overrides (member_id, reason_code, custom_deadline_days)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE custom_deadline_days = VALUES(custom_deadline_days)`,
        [mid, item.reason_code, customDeadline]
      )
      updated++
    }

    res.json({
      success: true,
      message: `已为 ${updated} 人设置还剩 ${remainingDays} 天`,
      data: { updated },
    })
  } catch (error) {
    console.error('批量设置考勤还剩天数失败:', error)
    res.status(500).json({ success: false, message: '批量设置失败' })
  }
})

/** 单个成员设置考勤还剩天数 body: { remaining_days: number | null, reason_code?: string } */
router.put('/attendance/:memberId/timeout', async (req, res) => {
  try {
    await ensureAttendanceOverrideTable()
    const memberId = parseInt(req.params.memberId, 10)
    if (!memberId) {
      return res.status(400).json({ success: false, message: '无效成员' })
    }

    const remainingRaw = req.body?.remaining_days
    const clear = remainingRaw === null || remainingRaw === '' || typeof remainingRaw === 'undefined'

    if (clear) {
      await pool.query('DELETE FROM attendance_reminder_overrides WHERE member_id = ?', [memberId])
      return res.json({ success: true, message: '已恢复默认考勤期限' })
    }

    const remainingDays = Math.max(0, parseInt(remainingRaw, 10) || 0)
    const ctx = await loadAttendanceContext()
    const member = ctx.members.find((m) => m.id === memberId)
    if (!member) {
      return res.status(404).json({ success: false, message: '成员不存在' })
    }
    const item = computeAttendanceForMember(member, ctx.leaveMap.get(memberId) || [], {
      ignored: false,
      inRetention: !!member.in_retention,
      showAll: true,
      overrides: {},
      formalTimeoutDays: ctx.formalTimeoutDays || 0,
      useFormal180: ctx.use180Set?.has(Number(memberId)),
      rulesConfig: ctx.rulesConfig,
    })
    if (!item) {
      return res.status(400).json({ success: false, message: '该成员当前无考勤计时' })
    }
    const reasonCode = String(req.body?.reason_code || item.reason_code)
    const clock = item.reasons.find((r) => r.reason_code === reasonCode) || item
    const customDeadline = Math.max(1, Number(clock.elapsed_days) + remainingDays)
    await pool.query(
      `INSERT INTO attendance_reminder_overrides (member_id, reason_code, custom_deadline_days)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE custom_deadline_days = VALUES(custom_deadline_days)`,
      [memberId, reasonCode, customDeadline]
    )
    res.json({
      success: true,
      message: `已设置还剩 ${remainingDays} 天`,
      data: { custom_deadline_days: customDeadline, reason_code: reasonCode },
    })
  } catch (error) {
    console.error('设置考勤还剩天数失败:', error)
    res.status(500).json({ success: false, message: '设置失败' })
  }
})

// 获取催促名单（实时从成员表计算）
// ?mode=remaining|kick_cycle 可覆盖系统默认显示模式
router.get('/', async (req, res) => {
  try {
    const cfg = await loadReminderConfig()
    const mode = req.query.mode === 'kick_cycle' || req.query.mode === 'remaining'
      ? req.query.mode
      : cfg.displayMode

    let rows = []
    let warnDays = cfg.trainingWarnDays ?? TRAINING_WARN_DAYS
    let kickMeta = null

    if (mode === 'kick_cycle') {
      kickMeta = cfg.kickInfo
      if (cfg.kickInfo.inWindow) {
        // 只显示「在本轮踢人日或之前就会超期」的人 = 还剩天数 ≤ 距踢人日天数
        // 不含「自定义延期」旁路：延期到踢人日之后的人不应出现在本轮踢人名单
        warnDays = cfg.kickInfo.daysUntilKick
        rows = await queryTrainingReminders(cfg.defaultTimeoutDays, warnDays, {
          includeCustomExtended: false,
          includeLeaveBuffer: false,
          formalTimeoutDays: cfg.formalTimeoutDays,
        })
      }
      // 非提醒窗口：名单为空（例如周二～周四）
    } else {
      warnDays = cfg.trainingWarnDays ?? TRAINING_WARN_DAYS
      rows = await queryTrainingReminders(cfg.defaultTimeoutDays, warnDays, {
        includeCustomExtended: true,
        formalTimeoutDays: cfg.formalTimeoutDays,
      })
    }

    res.json({
      success: true,
      data: rows,
      meta: {
        mode,
        timeoutDays: cfg.defaultTimeoutDays,
        formalTimeoutDays: cfg.formalTimeoutDays,
        warnDays,
        today: cfg.todayIso,
        kick: kickMeta,
      },
    })
  } catch (error) {
    console.error('获取催促名单失败:', error)
    res.status(500).json({ success: false, message: '获取催促名单失败' })
  }
})

// 自动更新催促名单（定时任务）
router.post('/auto-update', async (req, res) => {
  try {
    const { timeoutDays = 7 } = req.body
    
    const trainingStages = TRAINING_STAGES
    
    const [existingSettings] = await pool.query(`
      SELECT member_id, custom_timeout_days 
      FROM reminder_list 
      WHERE custom_timeout_days IS NOT NULL
    `)
    
    const customTimeoutMap = new Map()
    existingSettings.forEach(setting => {
      customTimeoutMap.set(setting.member_id, setting.custom_timeout_days)
    })
    
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
          (m.last_training_date IS NOT NULL AND DATEDIFF(CURDATE(), m.last_training_date) >= GREATEST(? - 3, 0))
          OR (m.last_training_date IS NULL AND m.join_date IS NOT NULL AND DATEDIFF(CURDATE(), m.join_date) >= GREATEST(? - 3, 0))
        )
        AND r.id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM leave_records al
          WHERE al.member_id = m.id AND al.status IN ('请假中', '待结束审批')
        )
    `, [...trainingStages, timeoutDays, timeoutDays])
    
    await pool.query('TRUNCATE TABLE reminder_list')
    
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
    
    const timeoutValue = custom_timeout_days > 0 ? custom_timeout_days : null
    
    for (const memberId of ids) {
      if (timeoutValue !== null) {
        const [existing] = await pool.query('SELECT id FROM reminder_list WHERE member_id = ?', [memberId])
        if (existing.length > 0) {
          await pool.query('UPDATE reminder_list SET custom_timeout_days = ? WHERE member_id = ?', [timeoutValue, memberId])
        } else {
          await pool.query(`
            INSERT INTO reminder_list (member_id, member_name, stage_role, last_training_date, days_without_training, custom_timeout_days)
            SELECT m.id, m.nickname, m.stage_role, m.last_training_date,
              CASE WHEN m.last_training_date IS NOT NULL
                THEN DATEDIFF(CURDATE(), m.last_training_date)
                ELSE DATEDIFF(CURDATE(), m.join_date)
              END,
              ?
            FROM members m WHERE m.id = ?
          `, [timeoutValue, memberId])
        }
      } else {
        await pool.query('DELETE FROM reminder_list WHERE member_id = ?', [memberId])
      }
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
    
    const timeoutValue = custom_timeout_days > 0 ? custom_timeout_days : null
    
    if (timeoutValue !== null) {
      const [existing] = await pool.query('SELECT id FROM reminder_list WHERE member_id = ?', [id])
      if (existing.length > 0) {
        await pool.query('UPDATE reminder_list SET custom_timeout_days = ? WHERE member_id = ?', [timeoutValue, id])
      } else {
        await pool.query(`
          INSERT INTO reminder_list (member_id, member_name, stage_role, last_training_date, days_without_training, custom_timeout_days)
          SELECT m.id, m.nickname, m.stage_role, m.last_training_date,
            CASE WHEN m.last_training_date IS NOT NULL
              THEN DATEDIFF(CURDATE(), m.last_training_date)
              ELSE DATEDIFF(CURDATE(), m.join_date)
            END,
            ?
          FROM members m WHERE m.id = ?
        `, [timeoutValue, id])
      }
    } else {
      await pool.query('DELETE FROM reminder_list WHERE member_id = ?', [id])
    }
    
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
    
    await pool.query('DELETE FROM reminder_list WHERE member_id = ?', [id])
    
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
