import express from 'express'
import { pool } from '../config/database.js'
import { requireAdmin } from '../utils/authGate.js'

const router = express.Router()

function dbError(res, error, fallback = '操作失败') {
  console.error('[anticheat]', error)
  const code = error?.code || error?.errno
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ENOTFOUND') {
    return res.status(503).json({ success: false, message: '数据库不可达，请稍后重试' })
  }
  return res.status(500).json({ success: false, message: error?.message || fallback })
}

/**
 * 截图 LONGBLOB 删除后 InnoDB 常不归还表空间（SQLPub 上 OPTIMIZE 无效）。
 * 表已空时 DROP+重建，把占用真正清掉。
 */
async function reclaimScreenshotSpaceIfEmpty() {
  try {
    const [[row]] = await pool.query('SELECT COUNT(*) AS c FROM screenshots')
    if (Number(row?.c) !== 0) {
      return { reclaimed: false, reason: 'screenshots_not_empty' }
    }
    await pool.query('DROP TABLE IF EXISTS screenshots')
    await pool.query(`
      CREATE TABLE screenshots (
        id INT NOT NULL AUTO_INCREMENT,
        exam_session_id INT NOT NULL COMMENT '考试会话ID',
        screenshot_data LONGBLOB NOT NULL COMMENT '截图数据',
        screenshot_time DATETIME NOT NULL COMMENT '截图时间',
        file_size INT DEFAULT NULL COMMENT '文件大小',
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_session (exam_session_id),
        KEY idx_time (screenshot_time),
        CONSTRAINT screenshots_ibfk_1 FOREIGN KEY (exam_session_id)
          REFERENCES exam_sessions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='截图表'
    `)
    console.log('[anticheat] screenshots 表已空，已重建以回收空间')
    return { reclaimed: true }
  } catch (e) {
    console.warn('[anticheat] 回收截图空间失败:', e.message)
    return { reclaimed: false, reason: e.message }
  }
}

router.use(requireAdmin)

// ─── 准考证 ───────────────────────────────────────────────

router.get('/tickets/available', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        aa.id,
        aa.member_id,
        aa.member_name,
        m.avatar AS avatar,
        m.qq AS qq,
        aa.admission_ticket,
        aa.preferred_date,
        aa.approved_at,
        aa.status,
        CASE WHEN ec.id IS NOT NULL THEN 1 ELSE 0 END AS imported
      FROM assessment_applications aa
      LEFT JOIN exam_configs ec ON aa.admission_ticket = ec.admission_ticket
      LEFT JOIN members m ON m.id = aa.member_id
      WHERE aa.status = '已通过' AND aa.admission_ticket IS NOT NULL
        AND (m.status IS NULL OR m.status != '已退队')
      ORDER BY aa.approved_at DESC
    `)
    res.json({ success: true, data: rows })
  } catch (error) {
    dbError(res, error, '获取可导入准考证失败')
  }
})

router.post('/tickets/import', async (req, res) => {
  try {
    const { admission_ticket, member_id, member_name, valid_days = 7 } = req.body
    if (!admission_ticket || !member_id || !member_name) {
      return res.status(400).json({ success: false, message: '缺少必要参数' })
    }
    const days = Math.min(365, Math.max(1, Number(valid_days) || 7))

    const [existing] = await pool.query(
      'SELECT id FROM exam_configs WHERE admission_ticket = ?',
      [admission_ticket]
    )
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: `准考证 ${admission_ticket} 已存在` })
    }

    const [result] = await pool.query(`
      INSERT INTO exam_configs
        (admission_ticket, member_id, member_name, valid_from, valid_until)
      VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))
    `, [admission_ticket, member_id, member_name, days])

    res.json({ success: true, data: { id: result.insertId } })
  } catch (error) {
    dbError(res, error, '导入准考证失败')
  }
})

router.post('/tickets/import/batch', async (req, res) => {
  try {
    const { tickets = [], valid_days = 7 } = req.body
    if (!Array.isArray(tickets) || tickets.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要导入的准考证' })
    }
    const days = Math.min(365, Math.max(1, Number(valid_days) || 7))
    let successCount = 0
    let skipCount = 0
    const errors = []

    for (const t of tickets) {
      try {
        const [existing] = await pool.query(
          'SELECT id FROM exam_configs WHERE admission_ticket = ?',
          [t.admission_ticket]
        )
        if (existing.length > 0) {
          skipCount++
          continue
        }
        await pool.query(`
          INSERT INTO exam_configs
            (admission_ticket, member_id, member_name, valid_from, valid_until)
          VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))
        `, [t.admission_ticket, t.member_id, t.member_name, days])
        successCount++
      } catch (e) {
        errors.push(`${t.admission_ticket}: ${e.message}`)
      }
    }

    res.json({ success: true, data: { successCount, skipCount, errors } })
  } catch (error) {
    dbError(res, error, '批量导入失败')
  }
})

// ─── 考核配置 ─────────────────────────────────────────────

router.get('/configs', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        ec.*,
        MAX(m.avatar) AS avatar,
        MAX(m.qq) AS qq,
        COUNT(mc.id) AS mod_count
      FROM exam_configs ec
      LEFT JOIN members m ON m.id = ec.member_id
      LEFT JOIN mod_configs mc ON ec.id = mc.exam_config_id
      WHERE m.status IS NULL OR m.status != '已退队'
      GROUP BY ec.id
      ORDER BY ec.created_at DESC
    `)
    res.json({ success: true, data: rows })
  } catch (error) {
    dbError(res, error, '获取考核配置失败')
  }
})

router.get('/configs/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM exam_configs WHERE id = ?', [req.params.id])
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '考核配置不存在' })
    }
    res.json({ success: true, data: rows[0] })
  } catch (error) {
    dbError(res, error, '获取考核配置失败')
  }
})

router.patch('/configs/:id', async (req, res) => {
  try {
    const id = req.params.id
    const {
      map_pack_required,
      require_antivirus_check,
      focus_screenshot_enabled,
      exam_status,
    } = req.body

    const fields = []
    const values = []

    if (typeof map_pack_required === 'boolean') {
      fields.push('map_pack_required = ?')
      values.push(map_pack_required)
    }
    if (typeof require_antivirus_check === 'boolean') {
      fields.push('require_antivirus_check = ?')
      values.push(require_antivirus_check)
    }
    if (typeof focus_screenshot_enabled === 'boolean') {
      fields.push('focus_screenshot_enabled = ?')
      values.push(focus_screenshot_enabled)
    }
    if (exam_status) {
      fields.push('exam_status = ?')
      values.push(exam_status)
    }

    if (!fields.length) {
      return res.status(400).json({ success: false, message: '没有可更新的字段' })
    }

    values.push(id)
    await pool.query(`UPDATE exam_configs SET ${fields.join(', ')} WHERE id = ?`, values)
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '更新考核配置失败')
  }
})

router.post('/configs/:id/reactivate', async (req, res) => {
  try {
    const extendDays = Math.min(365, Math.max(1, Number(req.body.extend_days) || 7))
    const [result] = await pool.query(`
      UPDATE exam_configs
      SET exam_status = '待开始',
          valid_until = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE id = ?
    `, [extendDays, req.params.id])
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '考核配置不存在' })
    }
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '重新激活失败')
  }
})

router.delete('/configs/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM exam_configs WHERE id = ?', [req.params.id])
    const space = await reclaimScreenshotSpaceIfEmpty()
    res.json({ success: true, data: { space } })
  } catch (error) {
    dbError(res, error, '删除考核配置失败')
  }
})

router.post('/configs/batch-delete', async (req, res) => {
  try {
    const { ids = [] } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要删除的配置' })
    }
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`DELETE FROM exam_configs WHERE id IN (${placeholders})`, ids)
    const space = await reclaimScreenshotSpaceIfEmpty()
    res.json({ success: true, data: { space } })
  } catch (error) {
    dbError(res, error, '批量删除失败')
  }
})

// ─── 模组（仅元数据）────────────────────────────────────

router.get('/configs/:id/mods', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, exam_config_id, mod_filename, mod_hash, mod_size, mod_path, created_at
      FROM mod_configs
      WHERE exam_config_id = ?
      ORDER BY mod_filename
    `, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (error) {
    dbError(res, error, '获取模组列表失败')
  }
})

router.post('/configs/:id/mods', async (req, res) => {
  try {
    const examConfigId = req.params.id
    const mods = Array.isArray(req.body.mods) ? req.body.mods : [req.body]
    if (!mods.length) {
      return res.status(400).json({ success: false, message: '请提供模组元数据' })
    }

    let successCount = 0
    const errors = []
    for (const mod of mods) {
      const filename = mod.filename || mod.mod_filename
      const hash = mod.hash || mod.mod_hash
      const size = mod.size ?? mod.mod_size
      const path = mod.path || mod.relativePath || mod.mod_path || filename
      if (!filename || !hash || size == null) {
        errors.push(`${filename || '?'}: 缺少 filename/hash/size`)
        continue
      }
      try {
        await pool.query(`
          INSERT INTO mod_configs
            (exam_config_id, mod_filename, mod_hash, mod_size, mod_path)
          VALUES (?, ?, ?, ?, ?)
        `, [examConfigId, filename, hash, size, path])
        successCount++
      } catch (e) {
        errors.push(`${filename}: ${e.message}`)
      }
    }

    res.json({ success: true, data: { successCount, errors } })
  } catch (error) {
    dbError(res, error, '添加模组失败')
  }
})

router.delete('/mods/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM mod_configs WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '删除模组失败')
  }
})

router.post('/mods/batch-delete', async (req, res) => {
  try {
    const { ids = [] } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要删除的模组' })
    }
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`DELETE FROM mod_configs WHERE id IN (${placeholders})`, ids)
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '批量删除模组失败')
  }
})

// ─── 监控会话 ─────────────────────────────────────────────

router.get('/sessions', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    const [rows] = await pool.query(`
      SELECT
        es.id,
        es.exam_config_id,
        es.steam_username,
        es.game_path,
        es.start_time,
        es.end_time,
        es.end_reason,
        es.last_heartbeat,
        es.screenshot_requested,
        es.created_at,
        ec.admission_ticket,
        ec.member_id,
        ec.member_name,
        m.avatar AS avatar,
        m.qq AS qq,
        ec.exam_status,
        CASE
          WHEN es.end_time IS NOT NULL THEN 0
          WHEN es.last_heartbeat IS NULL THEN 0
          WHEN TIMESTAMPDIFF(SECOND, es.last_heartbeat, NOW()) <= 30 THEN 1
          ELSE 0
        END AS is_alive
      FROM exam_sessions es
      JOIN exam_configs ec ON es.exam_config_id = ec.id
      LEFT JOIN members m ON m.id = ec.member_id
      ORDER BY es.start_time DESC
      LIMIT ?
    `, [limit])
    res.json({ success: true, data: rows })
  } catch (error) {
    dbError(res, error, '获取会话列表失败')
  }
})

async function endSession(sessionId, reason, status) {
  const [sessions] = await pool.query(
    'SELECT exam_config_id, end_time FROM exam_sessions WHERE id = ?',
    [sessionId]
  )
  if (!sessions.length) throw Object.assign(new Error('会话不存在'), { status: 404 })
  if (sessions[0].end_time) throw Object.assign(new Error('会话已结束'), { status: 400 })

  await pool.query(`
    UPDATE exam_sessions SET end_time = NOW(), end_reason = ? WHERE id = ?
  `, [reason, sessionId])

  let finalStatus = status
  if (!finalStatus) {
    finalStatus = (reason.includes('作弊') || reason.includes('强制终止')) ? '已终止' : '已完成'
  }
  await pool.query(
    'UPDATE exam_configs SET exam_status = ? WHERE id = ?',
    [finalStatus, sessions[0].exam_config_id]
  )
}

router.post('/sessions/:id/end', async (req, res) => {
  try {
    await endSession(req.params.id, req.body.reason || '管理员手动结束', '已完成')
    res.json({ success: true })
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message })
    dbError(res, error, '结束会话失败')
  }
})

router.post('/sessions/:id/terminate', async (req, res) => {
  try {
    await endSession(req.params.id, req.body.reason || '管理员强制终止', '已终止')
    res.json({ success: true })
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message })
    dbError(res, error, '强制终止失败')
  }
})

router.delete('/sessions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM exam_sessions WHERE id = ?', [req.params.id])
    const space = await reclaimScreenshotSpaceIfEmpty()
    res.json({ success: true, data: { space } })
  } catch (error) {
    dbError(res, error, '删除会话失败')
  }
})

router.post('/sessions/batch-end', async (req, res) => {
  try {
    const { ids = [] } = req.body
    let successCount = 0
    for (const id of ids) {
      try {
        await endSession(id, '管理员批量结束', '已完成')
        successCount++
      } catch { /* skip */ }
    }
    res.json({ success: true, data: { successCount } })
  } catch (error) {
    dbError(res, error, '批量结束失败')
  }
})

router.post('/sessions/batch-terminate', async (req, res) => {
  try {
    const { ids = [] } = req.body
    let successCount = 0
    for (const id of ids) {
      try {
        await endSession(id, '管理员批量强制终止', '已终止')
        successCount++
      } catch { /* skip */ }
    }
    res.json({ success: true, data: { successCount } })
  } catch (error) {
    dbError(res, error, '批量强制终止失败')
  }
})

router.post('/sessions/batch-delete', async (req, res) => {
  try {
    const { ids = [] } = req.body
    if (!ids.length) {
      return res.status(400).json({ success: false, message: '请选择要删除的会话' })
    }
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`DELETE FROM exam_sessions WHERE id IN (${placeholders})`, ids)
    const space = await reclaimScreenshotSpaceIfEmpty()
    res.json({ success: true, data: { space } })
  } catch (error) {
    dbError(res, error, '批量删除失败')
  }
})

/** 手动回收截图表空间（仅当 screenshots 已无数据时生效） */
router.post('/screenshots/reclaim-space', async (req, res) => {
  try {
    const space = await reclaimScreenshotSpaceIfEmpty()
    if (!space.reclaimed) {
      return res.status(400).json({
        success: false,
        message:
          space.reason === 'screenshots_not_empty'
            ? '仍有截图数据，请先删除全部相关会话后再回收'
            : space.reason || '回收失败',
        data: { space },
      })
    }
    res.json({ success: true, message: '已回收截图表空间', data: { space } })
  } catch (error) {
    dbError(res, error, '回收空间失败')
  }
})

router.post('/sessions/:id/request-screenshot', async (req, res) => {
  try {
    await pool.query(
      'UPDATE exam_sessions SET screenshot_requested = TRUE WHERE id = ? AND end_time IS NULL',
      [req.params.id]
    )
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '请求截图失败')
  }
})

router.post('/sessions/batch-request-screenshot', async (req, res) => {
  try {
    const { ids = [] } = req.body
    if (!ids.length) {
      return res.status(400).json({ success: false, message: '请选择会话' })
    }
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(
      `UPDATE exam_sessions SET screenshot_requested = TRUE WHERE id IN (${placeholders}) AND end_time IS NULL`,
      ids
    )
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '批量请求截图失败')
  }
})

// ─── 会话详情（分页 / 按需）───────────────────────────────

router.get('/sessions/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        es.*,
        ec.admission_ticket,
        ec.member_name,
        ec.member_id,
        m.avatar AS avatar,
        m.qq AS qq,
        ec.exam_status,
        ec.valid_from,
        ec.valid_until,
        ec.map_pack_required,
        ec.require_antivirus_check,
        ec.focus_screenshot_enabled,
        CASE
          WHEN es.end_time IS NOT NULL THEN 0
          WHEN es.last_heartbeat IS NULL THEN 0
          WHEN TIMESTAMPDIFF(SECOND, es.last_heartbeat, NOW()) <= 30 THEN 1
          ELSE 0
        END AS is_alive,
        (SELECT COUNT(*) FROM monitor_logs WHERE exam_session_id = es.id) AS log_count,
        (SELECT COUNT(*) FROM monitor_logs WHERE exam_session_id = es.id AND severity IN ('warning', 'error')) AS alert_log_count,
        (SELECT COUNT(*) FROM screenshots WHERE exam_session_id = es.id) AS screenshot_count,
        (SELECT COUNT(*) FROM file_snapshots WHERE exam_session_id = es.id) AS snapshot_count,
        (SELECT COUNT(*) FROM client_logs WHERE session_id = es.id) AS client_log_count
      FROM exam_sessions es
      JOIN exam_configs ec ON es.exam_config_id = ec.id
      LEFT JOIN members m ON m.id = ec.member_id
      WHERE es.id = ?
    `, [req.params.id])
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }
    res.json({ success: true, data: rows[0] })
  } catch (error) {
    dbError(res, error, '获取会话详情失败')
  }
})

router.get('/sessions/:id/logs', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const offset = (page - 1) * limit
    const logType = req.query.log_type || null

    let where = 'WHERE exam_session_id = ?'
    const params = [req.params.id]
    if (logType) {
      where += ' AND log_type = ?'
      params.push(logType)
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM monitor_logs ${where}`,
      params
    )
    const [rows] = await pool.query(
      `SELECT id, exam_session_id, log_type, log_content, severity, created_at
       FROM monitor_logs ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    )
    res.json({ success: true, data: rows, pagination: { page, limit, total } })
  } catch (error) {
    dbError(res, error, '获取监控日志失败')
  }
})

router.get('/sessions/:id/screenshots', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, exam_session_id, screenshot_time, file_size
      FROM screenshots
      WHERE exam_session_id = ?
      ORDER BY screenshot_time DESC
    `, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (error) {
    dbError(res, error, '获取截图列表失败')
  }
})

router.get('/screenshots/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT screenshot_data, file_size FROM screenshots WHERE id = ?',
      [req.params.id]
    )
    if (!rows.length || !rows[0].screenshot_data) {
      return res.status(404).json({ success: false, message: '截图不存在' })
    }
    const buf = Buffer.isBuffer(rows[0].screenshot_data)
      ? rows[0].screenshot_data
      : Buffer.from(rows[0].screenshot_data)
    res.json({
      success: true,
      data: {
        id: Number(req.params.id),
        file_size: rows[0].file_size || buf.length,
        contentType: 'image/png',
        base64: buf.toString('base64'),
      },
    })
  } catch (error) {
    dbError(res, error, '获取截图失败')
  }
})

router.get('/sessions/:id/snapshots', async (req, res) => {
  try {
    const fileType = req.query.file_type || null
    let sql = `
      SELECT id, exam_session_id, file_type, file_path, file_name, file_size, file_hash, snapshot_time
      FROM file_snapshots
      WHERE exam_session_id = ?
    `
    const params = [req.params.id]
    if (fileType) {
      sql += ' AND file_type = ?'
      params.push(fileType)
    }
    sql += ' ORDER BY file_type, file_path'
    const [rows] = await pool.query(sql, params)
    res.json({ success: true, data: rows })
  } catch (error) {
    dbError(res, error, '获取文件快照失败')
  }
})

router.get('/sessions/:id/processes', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const offset = (page - 1) * limit

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM monitor_logs
       WHERE exam_session_id = ? AND log_type = '进程检测'`,
      [req.params.id]
    )
    const [rows] = await pool.query(
      `SELECT id, log_content, severity, created_at
       FROM monitor_logs
       WHERE exam_session_id = ? AND log_type = '进程检测'
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [req.params.id, limit, offset]
    )
    res.json({ success: true, data: rows, pagination: { page, limit, total } })
  } catch (error) {
    dbError(res, error, '获取进程监控失败')
  }
})

router.get('/sessions/:id/client-logs', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 50))
    const offset = (page - 1) * limit

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM client_logs WHERE session_id = ?',
      [req.params.id]
    )
    const [rows] = await pool.query(
      `SELECT id, session_id, log_level, log_message, created_at
       FROM client_logs
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ? OFFSET ?`,
      [req.params.id, limit, offset]
    )
    res.json({ success: true, data: rows, pagination: { page, limit, total } })
  } catch (error) {
    dbError(res, error, '获取学员端日志失败')
  }
})

// ─── 系统设置 ─────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT config_key, config_value, description, updated_at
      FROM system_config
      WHERE config_key IN ('client_version', 'map_pack_password')
    `)
    const map = Object.fromEntries(rows.map((r) => [r.config_key, r]))
    res.json({
      success: true,
      data: {
        client_version: map.client_version?.config_value || '1.0.0',
        map_pack_password: map.map_pack_password?.config_value || '',
      },
    })
  } catch (error) {
    dbError(res, error, '获取系统设置失败')
  }
})

router.put('/settings', async (req, res) => {
  try {
    const { client_version, map_pack_password } = req.body
    if (client_version !== undefined) {
      await pool.query(`
        INSERT INTO system_config (config_key, config_value, description)
        VALUES ('client_version', ?, '客户端最低版本要求')
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)
      `, [String(client_version)])
    }
    if (map_pack_password !== undefined) {
      await pool.query(`
        INSERT INTO system_config (config_key, config_value, description)
        VALUES ('map_pack_password', ?, '考核地图压缩包解压密码')
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)
      `, [String(map_pack_password)])
    }
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '保存系统设置失败')
  }
})

// ─── 学员 DLL 误报白名单（按 member_id）──────────────────

async function ensureDllWhitelistTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dll_whitelist (
      id INT PRIMARY KEY AUTO_INCREMENT,
      member_id INT NULL COMMENT '学员ID',
      dll_name VARCHAR(255) NOT NULL COMMENT 'DLL文件名',
      dll_path VARCHAR(500) NULL COMMENT '原始完整路径',
      note VARCHAR(500) NULL COMMENT '备注',
      created_by VARCHAR(100) NULL COMMENT '添加人',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_member (member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  const [cols] = await pool.query(`
    SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dll_whitelist'
  `)
  const names = new Set((cols || []).map((c) => c.name))
  if (!names.has('member_id')) {
    await pool.query(`ALTER TABLE dll_whitelist ADD COLUMN member_id INT NULL COMMENT '学员ID' AFTER id`)
  }
  if (!names.has('dll_path')) {
    await pool.query(
      `ALTER TABLE dll_whitelist ADD COLUMN dll_path VARCHAR(500) NULL COMMENT '原始完整路径' AFTER dll_name`
    )
  }
  try {
    await pool.query(`ALTER TABLE dll_whitelist ADD UNIQUE KEY uk_member_dll (member_id, dll_name)`)
  } catch { /* exists */ }
}

router.get('/dll-whitelist', async (req, res) => {
  try {
    await ensureDllWhitelistTable()
    const memberId = Number(req.query.member_id)
    const q = String(req.query.q || '').trim()

    if (memberId) {
      const [rows] = await pool.query(`
        SELECT id, member_id, dll_name, dll_path, note, created_by, created_at
        FROM dll_whitelist
        WHERE member_id = ?
        ORDER BY created_at DESC
      `, [memberId])
      return res.json({ success: true, data: rows })
    }

    // 全局列表：不依赖会话，删除会话后仍可查看/管理
    const params = []
    let where = ''
    if (q) {
      where = `
        WHERE w.dll_name LIKE ? OR w.dll_path LIKE ? OR w.note LIKE ?
          OR m.nickname LIKE ? OR CAST(w.member_id AS CHAR) = ?
      `
      const like = `%${q}%`
      params.push(like, like, like, like, q)
    }
    const [rows] = await pool.query(`
      SELECT
        w.id, w.member_id, w.dll_name, w.dll_path, w.note, w.created_by, w.created_at,
        m.nickname AS member_name,
        m.qq AS member_qq,
        m.avatar AS avatar
      FROM dll_whitelist w
      LEFT JOIN members m ON m.id = w.member_id
      ${where}
      ORDER BY w.created_at DESC
      LIMIT 500
    `, params)
    res.json({ success: true, data: rows })
  } catch (error) {
    dbError(res, error, '获取DLL白名单失败')
  }
})

router.post('/dll-whitelist', async (req, res) => {
  try {
    await ensureDllWhitelistTable()
    const { member_id, dll_name, dll_path, note } = req.body
    const memberId = Number(member_id)
    const name = String(dll_name || '').trim()
    if (!memberId) {
      return res.status(400).json({ success: false, message: '请指定学员' })
    }
    if (!name) {
      return res.status(400).json({ success: false, message: '请填写 DLL 名称' })
    }
    const createdBy = req.admin?.username || null
    const [result] = await pool.query(`
      INSERT INTO dll_whitelist (member_id, dll_name, dll_path, note, created_by)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        dll_path = COALESCE(VALUES(dll_path), dll_path),
        note = COALESCE(VALUES(note), note)
    `, [
      memberId,
      name,
      String(dll_path || '').trim() || null,
      String(note || '').trim() || null,
      createdBy,
    ])
    res.json({ success: true, data: { id: result.insertId } })
  } catch (error) {
    dbError(res, error, '添加DLL白名单失败')
  }
})

router.delete('/dll-whitelist/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM dll_whitelist WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (error) {
    dbError(res, error, '删除DLL白名单失败')
  }
})

/** 从会话监控日志中解析触发考核终止的注入 DLL */
router.get('/sessions/:id/injection-dlls', async (req, res) => {
  try {
    const [logs] = await pool.query(`
      SELECT id, log_content, created_at
      FROM monitor_logs
      WHERE exam_session_id = ? AND log_type = 'DLL注入'
      ORDER BY created_at DESC
    `, [req.params.id])

    const [sessionRows] = await pool.query(`
      SELECT es.id, ec.member_id, ec.member_name, es.end_reason
      FROM exam_sessions es
      JOIN exam_configs ec ON es.exam_config_id = ec.id
      WHERE es.id = ?
    `, [req.params.id])

    const session = sessionRows[0] || null
    const seen = new Set()
    const dlls = []
    const re = /检测到DLL注入:\s*(.+?)\s*@\s*(.+)$/i
    for (const log of logs) {
      const m = String(log.log_content || '').match(re)
      if (!m) continue
      const dll_name = m[1].trim()
      const dll_path = m[2].trim()
      const key = dll_name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      dlls.push({
        dll_name,
        dll_path,
        log_id: log.id,
        created_at: log.created_at,
      })
    }

    // end_reason 兜底
    if (session?.end_reason) {
      const m = String(session.end_reason).match(/检测到DLL注入:\s*(.+)$/i)
      if (m) {
        const dll_name = m[1].trim().split(/\s+@\s+/)[0]
        if (dll_name && !seen.has(dll_name.toLowerCase())) {
          dlls.unshift({
            dll_name,
            dll_path: null,
            log_id: null,
            created_at: null,
            from_end_reason: true,
          })
        }
      }
    }

    res.json({
      success: true,
      data: {
        member_id: session?.member_id || null,
        member_name: session?.member_name || null,
        dlls,
      },
    })
  } catch (error) {
    dbError(res, error, '解析注入DLL失败')
  }
})

export default router
