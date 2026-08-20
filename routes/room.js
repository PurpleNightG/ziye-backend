import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

const ASSISTANT_FIELDS = 'id, username, nickname, qq, status, is_assistant, screen_share_enabled, screen_share_quota, screen_share_used, guest_code_max'

async function findMemberByDisplayName(name) {
  const [rows] = await pool.execute(
    `SELECT ${ASSISTANT_FIELDS} FROM members WHERE username = ? OR nickname = ? LIMIT 1`,
    [name, name]
  )
  return rows[0] || null
}

async function findMemberById(id) {
  const [rows] = await pool.execute(
    `SELECT ${ASSISTANT_FIELDS} FROM members WHERE id = ? LIMIT 1`,
    [id]
  )
  return rows[0] || null
}

function buildAssistantStatus(member) {
  if (!member?.is_assistant) {
    return {
      isAssistant: false,
      screenShareEnabled: false,
      screenShareQuota: null,
      screenShareUsed: 0,
      quotaRemaining: null,
      canUseRtc: false,
      guestCodeMax: 0,
    }
  }
  const quota = member.screen_share_quota
  const used = Number(member.screen_share_used) || 0
  const enabled = !!member.screen_share_enabled
  const hasQuota = quota == null || used < quota
  return {
    isAssistant: true,
    screenShareEnabled: enabled,
    screenShareQuota: quota,
    screenShareUsed: used,
    quotaRemaining: quota == null ? null : Math.max(0, quota - used),
    canUseRtc: enabled && hasQuota,
    guestCodeMax: Math.max(0, Number(member.guest_code_max) || 0),
  }
}

function formatAssistantRow(row) {
  const status = buildAssistantStatus(row)
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    qq: row.qq,
    status: row.status,
    screen_share_enabled: !!row.screen_share_enabled,
    screen_share_quota: row.screen_share_quota,
    screen_share_used: Number(row.screen_share_used) || 0,
    guest_code_max: status.guestCodeMax,
    quotaRemaining: status.quotaRemaining,
  }
}

function generateGuestCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = 'G'
  for (let i = 0; i < 7; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

const GUEST_HOST_MODES = ['peerjs', 'agora', 'volc']

function formatGuestCodeRow(row) {
  return {
    id: row.id,
    code: row.code,
    mode: row.mode,
    created_by_type: row.created_by_type,
    created_by_member_id: row.created_by_member_id,
    created_by_name: row.created_by_name,
    status: row.status,
    used_by_nickname: row.used_by_nickname,
    used_at: row.used_at,
    room_id: row.room_id,
    created_at: row.created_at,
  }
}

// ---- RTC Permission System (MySQL, must be before /:roomId routes) ----
// Auto-create table on first load
;(async () => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS rtc_permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(128) NOT NULL,
        mode ENUM('agora', 'volc', 'ziye') NOT NULL,
        status ENUM('pending', 'approved') NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_mode (username, mode)
      )
    `)
    try {
      await pool.execute(`ALTER TABLE rtc_permissions MODIFY COLUMN mode ENUM('agora', 'volc', 'ziye') NOT NULL`)
    } catch {}
  } catch (e) {
    console.error('Failed to create rtc_permissions table:', e.message)
  }
})()

const RTC_MODES = ['agora', 'volc']

/** 批量按显示名解析成员头像/QQ（屏幕共享在线列表用） */
router.post('/profiles-by-names', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.names) ? req.body.names : []
    const names = [...new Set(
      raw.map((n) => String(n || '').trim()).filter(Boolean)
    )].slice(0, 50)

    if (names.length === 0) {
      return res.json({ success: true, data: [] })
    }

    const placeholders = names.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT username, nickname, qq, avatar
       FROM members
       WHERE username IN (${placeholders}) OR nickname IN (${placeholders})`,
      [...names, ...names]
    )

    const byKey = new Map()
    for (const row of rows || []) {
      const profile = {
        nickname: row.nickname || row.username || '',
        qq: row.qq || null,
        avatar: row.avatar || null,
      }
      if (row.username) byKey.set(row.username, profile)
      if (row.nickname) byKey.set(row.nickname, profile)
    }

    const data = names.map((key) => {
      const hit = byKey.get(key)
      return {
        key,
        nickname: hit?.nickname || key,
        qq: hit?.qq || null,
        avatar: hit?.avatar || null,
      }
    })

    res.json({ success: true, data })
  } catch (error) {
    console.error('[room] profiles-by-names', error)
    res.status(500).json({ success: false, message: '解析成员资料失败' })
  }
})

// Student requests access to agora/volc
router.post('/rtc-request', async (req, res) => {
  try {
    const { username, mode } = req.body
    if (!username || !RTC_MODES.includes(mode)) {
      return res.status(400).json({ success: false, error: 'username and mode (agora/volc) required' })
    }
    await pool.execute(
      `INSERT INTO rtc_permissions (username, mode, status) VALUES (?, ?, 'pending')
       ON DUPLICATE KEY UPDATE status = IF(status = 'approved', 'approved', 'pending'), created_at = IF(status = 'approved', created_at, NOW())`,
      [username, mode]
    )
    res.json({ success: true, status: 'pending' })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Admin: get all pending requests
router.get('/rtc-requests', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT username, mode, UNIX_TIMESTAMP(created_at)*1000 AS requestedAt FROM rtc_permissions WHERE status = 'pending'`
    )
    res.json({ requests: rows })
  } catch (e) {
    res.status(500).json({ requests: [] })
  }
})

// Admin: approve a request
router.post('/rtc-approve', async (req, res) => {
  try {
    const { username, mode } = req.body
    await pool.execute(
      `UPDATE rtc_permissions SET status = 'approved' WHERE username = ? AND mode = ?`,
      [username, mode]
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Admin: reject a request
router.post('/rtc-reject', async (req, res) => {
  try {
    const { username, mode } = req.body
    await pool.execute(
      `DELETE FROM rtc_permissions WHERE username = ? AND mode = ?`,
      [username, mode]
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Student: check permission status (includes assistant bypass info)
router.get('/rtc-permission/:username', async (req, res) => {
  try {
    const username = req.params.username
    const memberId = req.query.memberId
    let member = null
    if (memberId) {
      member = await findMemberById(memberId)
    }
    if (!member) {
      member = await findMemberByDisplayName(username)
    }

    const [rows] = await pool.execute(
      `SELECT mode, status FROM rtc_permissions WHERE username = ?`,
      [username]
    )
    const result = { agora: false, volc: false, agoraPending: false, volcPending: false }
    for (const r of rows) {
      if (r.mode === 'agora') {
        if (r.status === 'approved') result.agora = true
        if (r.status === 'pending') result.agoraPending = true
      }
      if (r.mode === 'volc') {
        if (r.status === 'approved') result.volc = true
        if (r.status === 'pending') result.volcPending = true
      }
    }
    res.json({ ...result, ...buildAssistantStatus(member) })
  } catch (e) {
    res.json({
      agora: false, volc: false, agoraPending: false, volcPending: false,
      isAssistant: false, canUseRtc: false, quotaRemaining: null,
    })
  }
})

// Consume a one-time permission (student approval) or assistant quota (host only)
router.post('/rtc-consume', async (req, res) => {
  try {
    const { username, mode, memberId, asHost } = req.body
    let member = null
    if (memberId) {
      member = await findMemberById(memberId)
    }
    if (!member && username) {
      member = await findMemberByDisplayName(username)
    }

    if (member?.is_assistant && asHost) {
      if (!member.screen_share_enabled) {
        return res.status(403).json({ success: false, error: '助教屏幕共享权限已关闭' })
      }
      const used = Number(member.screen_share_used) || 0
      if (member.screen_share_quota != null && used >= member.screen_share_quota) {
        return res.status(403).json({ success: false, error: '助教屏幕共享次数已用完' })
      }
      await pool.execute(
        'UPDATE members SET screen_share_used = screen_share_used + 1 WHERE id = ?',
        [member.id]
      )
      return res.json({ success: true, type: 'assistant' })
    }

    if (!username || !RTC_MODES.includes(mode)) {
      return res.status(400).json({ success: false, error: 'username and mode required' })
    }
    await pool.execute(
      `DELETE FROM rtc_permissions WHERE username = ? AND mode = ?`,
      [username, mode]
    )
    res.json({ success: true, type: 'approval' })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Admin: list assistants and candidates
router.get('/assistants', async (_req, res) => {
  try {
    const [assistants] = await pool.execute(
      `SELECT ${ASSISTANT_FIELDS} FROM members WHERE is_assistant = 1 ORDER BY nickname ASC`
    )
    const [candidates] = await pool.execute(
      `SELECT id, username, nickname, qq, status FROM members
       WHERE is_assistant = 0 AND status != '已退队'
       ORDER BY nickname ASC`
    )
    res.json({
      assistants: assistants.map(formatAssistantRow),
      candidates,
    })
  } catch (e) {
    res.status(500).json({ assistants: [], candidates: [], error: e.message })
  }
})

// Admin: update assistant settings
router.put('/assistants/:memberId', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10)
    const {
      is_assistant,
      screen_share_enabled,
      screen_share_quota,
      guest_code_max,
      reset_used,
    } = req.body

    const member = await findMemberById(memberId)
    if (!member) {
      return res.status(404).json({ success: false, error: '成员不存在' })
    }

    const nextIsAssistant = is_assistant !== undefined ? !!is_assistant : !!member.is_assistant
    const nextEnabled = screen_share_enabled !== undefined ? !!screen_share_enabled : !!member.screen_share_enabled
    let nextQuota = member.screen_share_quota
    if (screen_share_quota !== undefined) {
      nextQuota = screen_share_quota === null || screen_share_quota === '' ? null : Math.max(0, parseInt(screen_share_quota, 10) || 0)
    }
    let nextGuestMax = Number(member.guest_code_max) || 1
    if (guest_code_max !== undefined) {
      nextGuestMax = Math.max(0, parseInt(guest_code_max, 10) || 0)
    }
    let nextUsed = Number(member.screen_share_used) || 0
    if (reset_used) {
      nextUsed = 0
    }

    await pool.execute(
      `UPDATE members SET
        is_assistant = ?,
        screen_share_enabled = ?,
        screen_share_quota = ?,
        screen_share_used = ?,
        guest_code_max = ?
      WHERE id = ?`,
      [nextIsAssistant ? 1 : 0, nextEnabled ? 1 : 0, nextQuota, nextUsed, nextGuestMax, memberId]
    )

    const updated = await findMemberById(memberId)
    res.json({ success: true, data: formatAssistantRow(updated) })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 生成访客码：助教生成会消耗一次共享次数，并可限制同时持有的未使用码数量 */
router.post('/guest-codes', async (req, res) => {
  try {
    const {
      mode,
      creatorType,
      memberId,
      creatorName,
    } = req.body || {}
    const hostMode = GUEST_HOST_MODES.includes(mode) ? mode : null
    if (!hostMode) {
      return res.status(400).json({ success: false, error: '请选择共享方式：peerjs / agora / volc' })
    }
    if (creatorType !== 'admin' && creatorType !== 'assistant') {
      return res.status(400).json({ success: false, error: 'creatorType 无效' })
    }

    let member = null
    if (creatorType === 'assistant') {
      if (!memberId) {
        return res.status(400).json({ success: false, error: '助教生成访客码需要 memberId' })
      }
      member = await findMemberById(memberId)
      if (!member?.is_assistant) {
        return res.status(403).json({ success: false, error: '仅助教可生成访客码' })
      }
      if (!member.screen_share_enabled) {
        return res.status(403).json({ success: false, error: '助教屏幕共享权限已关闭' })
      }
      const used = Number(member.screen_share_used) || 0
      if (member.screen_share_quota != null && used >= member.screen_share_quota) {
        return res.status(403).json({ success: false, error: '助教屏幕共享次数已用完' })
      }
      const guestMax = Math.max(0, Number(member.guest_code_max) || 0)
      const [activeRows] = await pool.execute(
        `SELECT COUNT(*) AS cnt FROM screen_share_guest_codes
         WHERE created_by_member_id = ? AND status = 'active'`,
        [member.id]
      )
      const activeCount = Number(activeRows[0]?.cnt) || 0
      if (activeCount >= guestMax) {
        return res.status(403).json({
          success: false,
          error: `未使用访客码已达上限（${guestMax} 个），请等待使用或删除后再生成`,
        })
      }
    }

    const displayCreator =
      String(creatorName || member?.nickname || member?.username || '管理员').trim() || '管理员'

    let code = generateGuestCode()
    for (let i = 0; i < 5; i++) {
      try {
        const conn = await pool.getConnection()
        try {
          await conn.beginTransaction()
          if (creatorType === 'assistant' && member) {
            const [lockRows] = await conn.execute(
              `SELECT id, screen_share_enabled, screen_share_quota, screen_share_used, guest_code_max
               FROM members WHERE id = ? FOR UPDATE`,
              [member.id]
            )
            const locked = lockRows[0]
            if (!locked?.screen_share_enabled) {
              await conn.rollback()
              return res.status(403).json({ success: false, error: '助教屏幕共享权限已关闭' })
            }
            const usedNow = Number(locked.screen_share_used) || 0
            if (locked.screen_share_quota != null && usedNow >= locked.screen_share_quota) {
              await conn.rollback()
              return res.status(403).json({ success: false, error: '助教屏幕共享次数已用完' })
            }
            const [cntRows] = await conn.execute(
              `SELECT COUNT(*) AS cnt FROM screen_share_guest_codes
               WHERE created_by_member_id = ? AND status = 'active'`,
              [member.id]
            )
            const guestMax = Math.max(0, Number(locked.guest_code_max) || 0)
            if ((Number(cntRows[0]?.cnt) || 0) >= guestMax) {
              await conn.rollback()
              return res.status(403).json({
                success: false,
                error: `未使用访客码已达上限（${guestMax} 个）`,
              })
            }
            await conn.execute(
              'UPDATE members SET screen_share_used = screen_share_used + 1 WHERE id = ?',
              [member.id]
            )
          }

          const [result] = await conn.execute(
            `INSERT INTO screen_share_guest_codes
              (code, mode, created_by_type, created_by_member_id, created_by_name, status)
             VALUES (?, ?, ?, ?, ?, 'active')`,
            [
              code,
              hostMode,
              creatorType,
              creatorType === 'assistant' ? member.id : null,
              displayCreator,
            ]
          )
          await conn.commit()
          return res.json({
            success: true,
            data: {
              id: result.insertId,
              code,
              mode: hostMode,
              created_by_type: creatorType,
              created_by_name: displayCreator,
              status: 'active',
            },
          })
        } catch (err) {
          await conn.rollback()
          throw err
        } finally {
          conn.release()
        }
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          code = generateGuestCode()
          continue
        }
        throw err
      }
    }
    res.status(500).json({ success: false, error: '生成访客码失败，请重试' })
  } catch (e) {
    console.error('[room] guest-codes create', e)
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 列出访客码：管理看全部（scope=admin）；助教只看自己的（scope=assistant&memberId） */
router.get('/guest-codes', async (req, res) => {
  try {
    const { scope, memberId } = req.query
    let rows = []

    if (scope === 'assistant') {
      const mid = parseInt(String(memberId || ''), 10)
      if (!Number.isFinite(mid) || mid <= 0) {
        return res.status(400).json({ success: false, data: [], error: '助教查询需要有效 memberId' })
      }
      ;[rows] = await pool.execute(
        `SELECT * FROM screen_share_guest_codes
         WHERE created_by_type = 'assistant'
           AND created_by_member_id = ?
           AND status IN ('active', 'used')
         ORDER BY created_at DESC
         LIMIT 100`,
        [mid]
      )
    } else if (scope === 'admin') {
      ;[rows] = await pool.execute(
        `SELECT * FROM screen_share_guest_codes
         WHERE status IN ('active', 'used')
         ORDER BY created_at DESC
         LIMIT 200`
      )
    } else {
      return res.status(400).json({
        success: false,
        data: [],
        error: '请指定 scope=admin 或 scope=assistant',
      })
    }

    res.json({ success: true, data: (rows || []).map(formatGuestCodeRow) })
  } catch (e) {
    res.status(500).json({ success: false, data: [], error: e.message })
  }
})

/** 校验访客码（不消耗，仅查询）— 须在 /:id 路由之前 */
router.post('/guest-codes/validate', async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase()
    if (!code) return res.status(400).json({ success: false, error: '请输入访客码' })
    const [rows] = await pool.execute(
      `SELECT id, code, mode, status FROM screen_share_guest_codes WHERE code = ? LIMIT 1`,
      [code]
    )
    const row = rows[0]
    if (!row) return res.status(404).json({ success: false, error: '访客码无效' })
    if (row.status === 'revoked') {
      return res.status(400).json({ success: false, error: '访客码已作废' })
    }
    if (row.status === 'used') {
      return res.status(400).json({ success: false, error: '访客码已被使用' })
    }
    res.json({ success: true, data: { id: row.id, code: row.code, mode: row.mode } })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 删除访客码：管理可删未使用/已用；助教只能删自己的未使用码（不退还次数） */
router.post('/guest-codes/:id/revoke', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const { memberId, asAdmin } = req.body || {}
    const [rows] = await pool.execute(
      'SELECT * FROM screen_share_guest_codes WHERE id = ? LIMIT 1',
      [id]
    )
    const row = rows[0]
    if (!row) return res.status(404).json({ success: false, error: '访客码不存在' })

    if (asAdmin) {
      if (row.status !== 'active' && row.status !== 'used') {
        return res.status(400).json({ success: false, error: '无法删除此访客码' })
      }
    } else {
      if (row.status !== 'active') {
        return res.status(403).json({ success: false, error: '助教只能删除未使用的访客码' })
      }
      if (!memberId || Number(row.created_by_member_id) !== Number(memberId)) {
        return res.status(403).json({ success: false, error: '无权删除此访客码' })
      }
    }

    await pool.execute(
      `DELETE FROM screen_share_guest_codes WHERE id = ?`,
      [id]
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ---- Share Logs (MySQL) ----
;(async () => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS share_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id VARCHAR(16) NOT NULL,
        host_name VARCHAR(128) NOT NULL,
        mode ENUM('peerjs', 'agora', 'volc', 'ziye') NOT NULL DEFAULT 'peerjs',
        peak_viewers INT NOT NULL DEFAULT 0,
        viewers TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL
      )
    `)
    // Add viewers column if table already existed without it
    try { await pool.execute(`ALTER TABLE share_logs ADD COLUMN viewers TEXT AFTER peak_viewers`) } catch {}
    try { await pool.execute(`ALTER TABLE share_logs MODIFY COLUMN mode ENUM('peerjs', 'agora', 'volc', 'ziye') NOT NULL DEFAULT 'peerjs'`) } catch {}
    // Note: we no longer auto-close stale records on startup because RTC connections
    // (Volcengine/Agora) may still be alive. Admin can manually close via active-rooms panel.
  } catch (e) {
    console.error('Failed to create share_logs table:', e.message)
  }
})()

// Admin: get share logs
router.get('/share-logs', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, room_id, host_name, mode, peak_viewers, viewers, started_at, ended_at
       FROM share_logs ORDER BY started_at DESC`
    )
    res.json({ logs: rows })
  } catch (e) {
    res.json({ logs: [] })
  }
})

// Admin: delete a share log (requires password)
router.delete('/share-logs/:id', async (req, res) => {
  const { password } = req.body || {}
  if (password !== '071031') {
    return res.status(403).json({ success: false, error: '删除密码错误' })
  }
  try {
    await pool.execute(`DELETE FROM share_logs WHERE id = ?`, [req.params.id])
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ---- Room Info ----
const rooms = new Map()
// Active user tracking: "userType:displayName" -> { role, roomId, displayName, registeredAt }
const activeUsers = new Map()
const killedRooms = new Map() // roomId -> adminName
const ACTIVE_USER_TTL = 2 * 60 * 60 * 1000 // 2 hours
const VIEWER_TIMEOUT = 120000 // 120 seconds without heartbeat = viewer gone (tolerates browser background tab throttling ~60s)

;(async () => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS room_invites (
        member_id INT NOT NULL PRIMARY KEY,
        room_id VARCHAR(16) NOT NULL,
        invited_by VARCHAR(128) NOT NULL,
        invited_at BIGINT NOT NULL,
        INDEX idx_room_invites_room (room_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS room_join_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id VARCHAR(16) NOT NULL,
        member_id INT NOT NULL,
        display_name VARCHAR(128) NOT NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_room_join_member (room_id, member_id),
        INDEX idx_room_join_status (room_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch (e) {
    console.warn('[room] invite/join table init:', e.message)
  }
})()

// Composite key to distinguish admin vs student with same name
function userKey(displayName, userType) {
  return userType ? `${userType}:${displayName}` : displayName
}

function inviteMemberKey(memberId) {
  const n = Number(memberId)
  return Number.isFinite(n) && n > 0 ? n : 0
}

async function clearInvitesForRoom(roomId) {
  const rid = String(roomId || '').toUpperCase()
  try {
    await pool.execute(`DELETE FROM room_invites WHERE room_id = ?`, [rid])
    await pool.execute(`DELETE FROM room_join_requests WHERE room_id = ?`, [rid])
  } catch (e) {
    console.warn('[room] clearInvitesForRoom:', e.message)
  }
}

async function upsertRoomInvite(memberId, roomId, invitedBy) {
  const mid = inviteMemberKey(memberId)
  const rid = String(roomId || '').toUpperCase()
  if (!mid || !rid) return
  await pool.execute(
    `INSERT INTO room_invites (member_id, room_id, invited_by, invited_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE room_id = VALUES(room_id), invited_by = VALUES(invited_by), invited_at = VALUES(invited_at)`,
    [mid, rid, String(invitedBy || '').slice(0, 128), Date.now()]
  )
}

async function deleteRoomInvite(memberId, roomId) {
  const mid = inviteMemberKey(memberId)
  if (!mid) return
  const rid = roomId ? String(roomId).toUpperCase() : ''
  if (rid) {
    await pool.execute(`DELETE FROM room_invites WHERE member_id = ? AND room_id = ?`, [mid, rid])
  } else {
    await pool.execute(`DELETE FROM room_invites WHERE member_id = ?`, [mid])
  }
}

async function getRoomJoinStatus(roomId, memberId) {
  const mid = inviteMemberKey(memberId)
  const rid = String(roomId || '').toUpperCase()
  if (!mid || !rid) return null
  const [rows] = await pool.execute(
    `SELECT status FROM room_join_requests WHERE room_id = ? AND member_id = ? LIMIT 1`,
    [rid, mid]
  )
  return rows[0]?.status || null
}

function canInviteToRoom(room, { userType, hostName }) {
  if (!room?.hostName) return false
  if (userType === 'admin') return true
  return hostName && String(hostName) === String(room.hostName)
}

// Periodic cleanup: remove stale activeUsers entries for viewers whose heartbeats expired.
// This ensures abruptly disconnected viewers (network drop, browser crash, closed tab where
// sendBeacon failed) don't stay "locked" in activeUsers for up to ACTIVE_USER_TTL.
setInterval(() => {
  const now = Date.now()
  for (const [roomId, room] of rooms.entries()) {
    for (const [uid] of Array.from(room.viewers.entries())) {
      const hb = room.viewerHeartbeats.get(uid)
      if (hb && now - hb >= VIEWER_TIMEOUT) {
        const storedKey = room.viewerKeys.get(uid)
        if (storedKey) {
          activeUsers.delete(storedKey)
          room.viewerKeys.delete(uid)
        }
        room.viewers.delete(uid)
        room.viewerHeartbeats.delete(uid)
        room.viewerMemberIds?.delete(uid)
      }
    }
  }
}, 30000) // Run every 30 seconds

function getRoom(roomId) {
  const id = String(roomId || '').toUpperCase()
  if (!rooms.has(id)) {
    rooms.set(id, {
      hostName: '', hostKey: '', viewers: new Map(), viewerKeys: new Map(),
      viewerMemberIds: new Map(),
      viewerHeartbeats: new Map(), mode: 'peerjs', peakViewers: 0, allViewerNames: new Set(),
      qualityPrefs: new Map(), fpsPrefs: new Map(),
      hostQuality: 1080, hostFps: 60,
    })
  }
  const room = rooms.get(id)
  if (!room.qualityPrefs) room.qualityPrefs = new Map()
  if (!room.fpsPrefs) room.fpsPrefs = new Map()
  if (!room.viewerMemberIds) room.viewerMemberIds = new Map()
  if (!room.hostQuality) room.hostQuality = 1080
  if (!room.hostFps) room.hostFps = 60
  return room
}

/** 按房间号查找进行中的共享（大小写不敏感） */
function findLiveRoom(roomId) {
  const upper = String(roomId || '').toUpperCase()
  if (!upper) return null
  const direct = rooms.get(upper)
  if (direct?.hostName) return { roomId: upper, room: direct }
  for (const [k, v] of rooms.entries()) {
    if (String(k).toUpperCase() === upper && v?.hostName) {
      return { roomId: k, room: v }
    }
  }
  return null
}

/** 当前在房观看的学员 memberId（优先 id，避免同名误伤） */
function getWatchingMemberIds(room) {
  const ids = new Set()
  if (!room) return ids
  const now = Date.now()
  for (const [uid] of room.viewers.entries()) {
    const hb = room.viewerHeartbeats.get(uid)
    if (hb && now - hb >= VIEWER_TIMEOUT) continue
    const mid = room.viewerMemberIds?.get(uid)
    if (mid != null && Number(mid) > 0) ids.add(Number(mid))
  }
  return ids
}

function getTargetQuality(room) {
  const cap = room?.hostQuality || 1080
  if (!room?.qualityPrefs || room.qualityPrefs.size === 0) return cap
  return Math.min(cap, ...room.qualityPrefs.values())
}

function getTargetFps(room) {
  const cap = room?.hostFps || 60
  if (!room?.fpsPrefs || room.fpsPrefs.size === 0) return cap
  return Math.min(cap, ...room.fpsPrefs.values())
}

function getActiveViewers(room) {
  const now = Date.now()
  const names = []
  for (const [uid, name] of room.viewers.entries()) {
    const hb = room.viewerHeartbeats.get(uid)
    if (!hb || now - hb < VIEWER_TIMEOUT) names.push(name)
  }
  return names
}

// Check if user is already active in another role
router.get('/active-check/:displayName', (req, res) => {
  const name = decodeURIComponent(req.params.displayName)
  const ut = req.query.userType || ''
  const key = userKey(name, ut)
  const info = activeUsers.get(key)
  if (info) {
    // Auto-expire stale entries
    if (Date.now() - info.registeredAt > ACTIVE_USER_TTL) {
      activeUsers.delete(key)
      return res.json({ active: false })
    }
    res.json({ active: true, role: info.role, roomId: info.roomId })
  } else {
    res.json({ active: false })
  }
})

// Force-leave: clear stale active status
router.post('/force-leave', (req, res) => {
  const { displayName, userType: ut } = req.body || {}
  if (!displayName) return res.status(400).json({ success: false })
  const key = userKey(displayName, ut)
  activeUsers.delete(key)
  res.json({ success: true })
})

/** 学员：查询待处理屏幕共享邀请 */
router.get('/invites/pending', async (req, res) => {
  try {
    const memberId = inviteMemberKey(req.query.memberId)
    if (!memberId) return res.json({ invite: null })
    const [rows] = await pool.execute(
      `SELECT room_id, invited_by, invited_at FROM room_invites WHERE member_id = ? LIMIT 1`,
      [memberId]
    )
    const inv = rows[0]
    if (!inv) return res.json({ invite: null })
    const roomId = String(inv.room_id || '').toUpperCase()
    const room = rooms.get(roomId) || findLiveRoom(roomId)?.room
    let hostName = room?.hostName || ''
    let mode = room?.mode || 'peerjs'
    let viewerCount = room ? getActiveViewers(room).length : 0
    if (!hostName) {
      // 多实例：本进程无房间时用 share_logs 确认仍在进行，勿误删邀请
      const [logs] = await pool.execute(
        `SELECT host_name, mode FROM share_logs WHERE room_id = ? AND ended_at IS NULL LIMIT 1`,
        [roomId]
      )
      if (!logs[0]?.host_name) {
        await deleteRoomInvite(memberId, roomId)
        return res.json({ invite: null })
      }
      hostName = logs[0].host_name
      mode = logs[0].mode || 'peerjs'
    }
    res.json({
      invite: {
        roomId,
        hostName,
        invitedBy: inv.invited_by,
        invitedAt: Number(inv.invited_at) || 0,
        viewerCount,
        mode,
      },
    })
  } catch (e) {
    console.warn('[room] invites/pending:', e.message)
    res.json({ invite: null })
  }
})

/** 学员：接受或忽略屏幕共享邀请 */
router.post('/invites/respond', async (req, res) => {
  try {
    const { memberId, roomId, accept } = req.body || {}
    const mid = inviteMemberKey(memberId)
    if (!mid) return res.status(400).json({ success: false, error: '缺少 memberId' })
    const rid = roomId ? String(roomId).toUpperCase() : ''
    const [rows] = await pool.execute(
      rid
        ? `SELECT room_id FROM room_invites WHERE member_id = ? AND room_id = ? LIMIT 1`
        : `SELECT room_id FROM room_invites WHERE member_id = ? LIMIT 1`,
      rid ? [mid, rid] : [mid]
    )
    const invRoom = rows[0]?.room_id ? String(rows[0].room_id).toUpperCase() : rid
    await deleteRoomInvite(mid, invRoom || undefined)
    // 接受邀请视为已批准进入
    if (accept && invRoom && mid) {
      await pool.execute(
        `INSERT INTO room_join_requests (room_id, member_id, display_name, status)
         VALUES (?, ?, ?, 'approved')
         ON DUPLICATE KEY UPDATE status = 'approved', updated_at = CURRENT_TIMESTAMP`,
        [invRoom, mid, String(req.body?.displayName || '').slice(0, 128) || `成员${mid}`]
      )
    }
    res.json({ success: true, accept: !!accept })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 学员：自己的进入申请状态 */
router.get('/join-requests/mine', async (req, res) => {
  try {
    const mid = inviteMemberKey(req.query.memberId)
    if (!mid) return res.json({ requests: [] })
    const [rows] = await pool.execute(
      `SELECT room_id, display_name, status, UNIX_TIMESTAMP(created_at)*1000 AS createdAt,
              UNIX_TIMESTAMP(updated_at)*1000 AS updatedAt
       FROM room_join_requests
       WHERE member_id = ? AND status IN ('pending', 'approved', 'rejected')
       ORDER BY updated_at DESC
       LIMIT 20`,
      [mid]
    )
    res.json({
      requests: rows.map((r) => ({
        roomId: String(r.room_id).toUpperCase(),
        displayName: r.display_name,
        status: r.status,
        createdAt: Number(r.createdAt) || 0,
        updatedAt: Number(r.updatedAt) || 0,
      })),
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, requests: [] })
  }
})

/** 主机 / 管理员：当前可审批的进入申请（全站浮窗用） */
router.get('/join-requests/hosting', async (req, res) => {
  try {
    const hostName = String(req.query.hostName || req.query.displayName || '').trim()
    const userType = String(req.query.userType || '').trim()
    const roomIds = []
    for (const [rid, room] of rooms.entries()) {
      if (!room?.hostName) continue
      if (!canInviteToRoom(room, { userType, hostName })) continue
      roomIds.push(String(rid).toUpperCase())
    }
    if (!roomIds.length) return res.json({ requests: [] })

    const placeholders = roomIds.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT id, room_id, member_id, display_name, status, UNIX_TIMESTAMP(created_at)*1000 AS createdAt
       FROM room_join_requests
       WHERE status = 'pending' AND room_id IN (${placeholders})
       ORDER BY created_at ASC
       LIMIT 50`,
      roomIds
    )
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        roomId: String(r.room_id).toUpperCase(),
        memberId: Number(r.member_id),
        displayName: r.display_name,
        status: r.status,
        createdAt: Number(r.createdAt) || 0,
      })),
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, requests: [] })
  }
})

/** 可邀请观看的成员（未退队、且当前不在该房间观看）
 *  不按 hostName 排除同名学员；仅排除真实观看者 memberId，以及可选的 excludeMemberId（自己）
 */
router.get('/:roomId/invite-candidates', async (req, res) => {
  try {
    const found = findLiveRoom(req.params.roomId)
    if (!found) {
      return res.status(404).json({ success: false, error: '房间不存在或已关闭' })
    }
    const { room } = found
    const watchingIds = getWatchingMemberIds(room)
    const excludeSelf = inviteMemberKey(req.query.excludeMemberId)
    if (excludeSelf > 0) watchingIds.add(excludeSelf)

    const [rows] = await pool.execute(
      `SELECT id, nickname, username, qq, avatar, stage_role, last_training_date
       FROM members
       WHERE status != '已退队'
       ORDER BY (last_training_date IS NULL) ASC, last_training_date DESC, nickname ASC, id ASC`
    )
    const candidates = rows
      .map((row) => {
        const id = Number(row.id)
        return {
          id,
          nickname: row.nickname || row.username || `成员${row.id}`,
          username: row.username || '',
          qq: row.qq != null ? String(row.qq) : null,
          avatar: row.avatar || null,
          stageRole: row.stage_role || null,
          inRoom: watchingIds.has(id),
        }
      })
      .filter((c) => !c.inRoom)
    res.json({ success: true, candidates })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * 邀请指定成员观看屏幕共享
 * body: { hostName, userType, memberIds[] }
 */
router.post('/:roomId/invite', async (req, res) => {
  try {
    const found = findLiveRoom(req.params.roomId)
    if (!found) {
      return res.status(404).json({ success: false, error: '房间不存在或已关闭' })
    }
    const { roomId, room } = found
    const { userType, hostName, displayName, memberIds } = req.body || {}
    if (!canInviteToRoom(room, { userType, hostName: hostName || displayName })) {
      return res.status(403).json({ success: false, error: '仅共享者可邀请' })
    }

    const ids = [...new Set(
      (Array.isArray(memberIds) ? memberIds : [])
        .map((id) => inviteMemberKey(id))
        .filter((id) => id > 0)
    )]
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: '请选择要邀请的成员' })
    }

    const watchingIds = getWatchingMemberIds(room)

    const placeholders = ids.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT id, nickname, username FROM members WHERE id IN (${placeholders}) AND status != '已退队'`,
      ids
    )

    let invitedCount = 0
    const invitedBy = displayName || hostName || room.hostName
    for (const row of rows) {
      const mid = inviteMemberKey(row.id)
      if (!mid) continue
      // 只按 memberId 判断是否已在观看，避免同名误伤
      if (watchingIds.has(mid)) continue
      await upsertRoomInvite(mid, roomId, invitedBy)
      invitedCount++
    }
    res.json({ success: true, invitedCount })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 学员申请进入屏幕共享观看 */
router.post('/:roomId/join-request', async (req, res) => {
  try {
    const found = findLiveRoom(req.params.roomId)
    if (!found) {
      return res.status(404).json({ success: false, error: '房间不存在或已关闭' })
    }
    const { roomId, room } = found
    const mid = inviteMemberKey(req.body?.memberId)
    const displayName = String(req.body?.displayName || '').trim().slice(0, 128)
    if (!mid) return res.status(400).json({ success: false, error: '请先登录学员账号' })
    if (!displayName) return res.status(400).json({ success: false, error: '缺少显示名' })

    // 禁止申请进入自己开的共享
    const host = String(room.hostName || '').trim().toLowerCase()
    if (host) {
      const aliases = new Set([displayName.toLowerCase()])
      try {
        const [rows] = await pool.execute(
          `SELECT nickname, username FROM members WHERE id = ? LIMIT 1`,
          [mid]
        )
        const row = rows[0]
        if (row?.nickname) aliases.add(String(row.nickname).trim().toLowerCase())
        if (row?.username) aliases.add(String(row.username).trim().toLowerCase())
      } catch {}
      if (aliases.has(host)) {
        return res.status(400).json({ success: false, error: '不能申请进入自己的共享' })
      }
    }

    if (getWatchingMemberIds(room).has(mid)) {
      return res.json({ success: true, status: 'approved', alreadyIn: true })
    }
    await pool.execute(
      `INSERT INTO room_join_requests (room_id, member_id, display_name, status)
       VALUES (?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         status = IF(status = 'approved', 'approved', 'pending'),
         updated_at = CURRENT_TIMESTAMP`,
      [String(roomId).toUpperCase(), mid, displayName]
    )
    const status = await getRoomJoinStatus(roomId, mid)
    res.json({ success: true, status: status || 'pending' })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 主机：待批进入申请 */
router.get('/:roomId/join-requests', async (req, res) => {
  try {
    const found = findLiveRoom(req.params.roomId)
    if (!found) return res.json({ requests: [] })
    const { roomId, room } = found
    const hostName = req.query.hostName || req.query.displayName
    const userType = req.query.userType
    if (!canInviteToRoom(room, { userType, hostName })) {
      return res.status(403).json({ success: false, error: '仅共享者可查看申请', requests: [] })
    }
    const [rows] = await pool.execute(
      `SELECT id, member_id, display_name, status, UNIX_TIMESTAMP(created_at)*1000 AS createdAt
       FROM room_join_requests
       WHERE room_id = ? AND status = 'pending'
       ORDER BY created_at ASC`,
      [String(roomId).toUpperCase()]
    )
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        memberId: Number(r.member_id),
        displayName: r.display_name,
        status: r.status,
        createdAt: Number(r.createdAt) || 0,
      })),
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, requests: [] })
  }
})

/** 主机同意进入申请 */
router.post('/:roomId/join-approve', async (req, res) => {
  try {
    const found = findLiveRoom(req.params.roomId)
    if (!found) return res.status(404).json({ success: false, error: '房间不存在或已关闭' })
    const { roomId, room } = found
    const { userType, hostName, displayName, memberId, requestId } = req.body || {}
    if (!canInviteToRoom(room, { userType, hostName: hostName || displayName })) {
      return res.status(403).json({ success: false, error: '仅共享者可审批' })
    }
    const mid = inviteMemberKey(memberId)
    const rid = String(roomId).toUpperCase()
    if (requestId) {
      await pool.execute(
        `UPDATE room_join_requests SET status = 'approved' WHERE id = ? AND room_id = ?`,
        [requestId, rid]
      )
    } else if (mid) {
      await pool.execute(
        `UPDATE room_join_requests SET status = 'approved' WHERE room_id = ? AND member_id = ?`,
        [rid, mid]
      )
    } else {
      return res.status(400).json({ success: false, error: '缺少申请信息' })
    }
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 主机拒绝进入申请 */
router.post('/:roomId/join-reject', async (req, res) => {
  try {
    const found = findLiveRoom(req.params.roomId)
    if (!found) return res.status(404).json({ success: false, error: '房间不存在或已关闭' })
    const { roomId, room } = found
    const { userType, hostName, displayName, memberId, requestId } = req.body || {}
    if (!canInviteToRoom(room, { userType, hostName: hostName || displayName })) {
      return res.status(403).json({ success: false, error: '仅共享者可审批' })
    }
    const mid = inviteMemberKey(memberId)
    const rid = String(roomId).toUpperCase()
    if (requestId) {
      await pool.execute(
        `UPDATE room_join_requests SET status = 'rejected' WHERE id = ? AND room_id = ?`,
        [requestId, rid]
      )
    } else if (mid) {
      await pool.execute(
        `UPDATE room_join_requests SET status = 'rejected' WHERE room_id = ? AND member_id = ?`,
        [rid, mid]
      )
    } else {
      return res.status(400).json({ success: false, error: '缺少申请信息' })
    }
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** 学员可读的在线共享列表（不含观众名单） */
router.get('/live', async (req, res) => {
  const list = []
  const seenRoomIds = new Set()
  for (const [roomId, room] of rooms.entries()) {
    if (!room.hostName) continue
    seenRoomIds.add(roomId)
    list.push({
      roomId,
      hostName: room.hostName,
      mode: room.mode || 'peerjs',
      viewerCount: getActiveViewers(room).length,
    })
  }
  try {
    const [rows] = await pool.execute(
      `SELECT room_id, host_name, mode FROM share_logs WHERE ended_at IS NULL`
    )
    for (const row of rows) {
      if (seenRoomIds.has(row.room_id)) continue
      list.push({
        roomId: row.room_id,
        hostName: row.host_name,
        mode: row.mode,
        viewerCount: 0,
      })
    }
  } catch {}
  res.json({ rooms: list })
})

// List all active rooms (admin)
router.get('/active-rooms', async (req, res) => {
  const list = []
  const seenRoomIds = new Set()
  // In-memory rooms (live data)
  for (const [roomId, room] of rooms.entries()) {
    if (!room.hostName) continue
    seenRoomIds.add(roomId)
    const activeViewers = getActiveViewers(room)
    list.push({
      roomId,
      hostName: room.hostName,
      mode: room.mode,
      viewerCount: activeViewers.length,
      viewers: activeViewers,
    })
  }
  // DB fallback: share_logs with ended_at IS NULL not already in memory
  try {
    const [rows] = await pool.execute(
      `SELECT room_id, host_name, mode FROM share_logs WHERE ended_at IS NULL`
    )
    for (const row of rows) {
      if (seenRoomIds.has(row.room_id)) continue
      list.push({
        roomId: row.room_id,
        hostName: row.host_name,
        mode: row.mode,
        viewerCount: 0,
        viewers: [],
      })
    }
  } catch {}
  res.json({ rooms: list })
})

// Admin force-close a room
router.post('/admin-close/:roomId', async (req, res) => {
  const room = rooms.get(req.params.roomId)
  if (room) {
    if (room.hostKey) activeUsers.delete(room.hostKey)
    room.viewerKeys.forEach((vKey) => activeUsers.delete(vKey))
    try {
      // viewers already persisted incrementally; just close with peak
      await pool.execute(
        `UPDATE share_logs SET ended_at = NOW(), peak_viewers = GREATEST(peak_viewers, ?) WHERE room_id = ? AND ended_at IS NULL`,
        [room.peakViewers, req.params.roomId]
      )
    } catch {}
    clearInvitesForRoom(req.params.roomId)
    rooms.delete(req.params.roomId)
  } else {
    // Room not in memory, clean DB
    try {
      await pool.execute(
        `UPDATE share_logs SET ended_at = NOW() WHERE room_id = ? AND ended_at IS NULL`,
        [req.params.roomId]
      )
    } catch {}
    clearInvitesForRoom(req.params.roomId)
  }
  const { adminName } = req.body || {}
  killedRooms.set(req.params.roomId, adminName || '管理员')
  res.json({ success: true })
})

// Host registers room with display name
router.post('/:roomId/host', async (req, res) => {
  const room = getRoom(req.params.roomId)
  const { displayName, mode, userType: ut, guestCode } = req.body

  let resolvedMode = mode || 'peerjs'
  let guestCodeId = null

  // 访客发起共享：必须带有效访客码，且模式与码绑定
  if (ut === 'guest' || guestCode) {
    const code = String(guestCode || '').trim().toUpperCase()
    if (!code) {
      return res.status(400).json({ success: false, error: '访客发起共享需要访客码' })
    }
    try {
      const [rows] = await pool.execute(
        `SELECT id, mode, status FROM screen_share_guest_codes WHERE code = ? LIMIT 1`,
        [code]
      )
      const row = rows[0]
      if (!row) return res.status(404).json({ success: false, error: '访客码无效' })
      if (row.status === 'revoked') {
        return res.status(400).json({ success: false, error: '访客码已作废' })
      }
      if (row.status === 'used') {
        return res.status(400).json({ success: false, error: '访客码已被使用' })
      }
      resolvedMode = row.mode
      guestCodeId = row.id
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message })
    }
  }

  if (displayName) {
    const key = userKey(displayName, ut)
    const existing = activeUsers.get(key)
    if (existing && existing.roomId !== req.params.roomId) {
      return res.status(409).json({ success: false, error: `你已经在房间 ${existing.roomId} 中${existing.role === 'host' ? '分享' : '观看'}，请先退出` })
    }
    killedRooms.delete(req.params.roomId)

    room.hostName = displayName
    room.hostKey = key
    room.mode = resolvedMode
    room.peakViewers = 0
    activeUsers.set(key, { role: 'host', roomId: req.params.roomId, displayName, registeredAt: Date.now() })
    room.viewerHeartbeats.clear()
    // Insert share log
    try {
      await pool.execute(
        `INSERT INTO share_logs (room_id, host_name, mode) VALUES (?, ?, ?)`,
        [req.params.roomId, displayName, room.mode]
      )
      console.log(`[ShareLog] Inserted: room=${req.params.roomId} host=${displayName} mode=${room.mode}`)
    } catch (e) {
      console.error(`[ShareLog] INSERT failed:`, e.message)
    }

    if (guestCodeId) {
      try {
        const [upd] = await pool.execute(
          `UPDATE screen_share_guest_codes
           SET status = 'used', used_by_nickname = ?, used_at = NOW(), room_id = ?
           WHERE id = ? AND status = 'active'`,
          [displayName, req.params.roomId, guestCodeId]
        )
        if (upd.affectedRows === 0) {
          // 并发下码已被用：回滚本房间主机登记
          if (room.hostKey) activeUsers.delete(room.hostKey)
          room.hostName = null
          room.hostKey = null
          return res.status(400).json({ success: false, error: '访客码已被使用' })
        }
      } catch (e) {
        console.error('[GuestCode] redeem failed:', e.message)
      }
    }
  }
  room.viewers.clear()
  room.viewerKeys.clear()
  room.viewerHeartbeats.clear()
  res.json({ success: true, mode: room.mode })
})

// Viewer joins room with display name
// body.fromRequest: true 时必须已获批准（来自在线房间申请）
router.post('/:roomId/viewer', async (req, res) => {
  const room = getRoom(req.params.roomId)
  const { userId, displayName, userType: ut, memberId, fromRequest } = req.body
  const mid = inviteMemberKey(memberId)
  const rid = String(req.params.roomId || '').toUpperCase()

  if (fromRequest) {
    if (!mid) {
      return res.status(403).json({ success: false, error: '申请进入需要登录学员账号' })
    }
    const status = await getRoomJoinStatus(rid, mid)
    if (status !== 'approved') {
      return res.status(403).json({
        success: false,
        error: status === 'pending' ? '等待共享者同意进入' : '尚未获得进入许可，请先申请',
        joinStatus: status || 'none',
      })
    }
  }

  if (displayName) {
    const key = userKey(displayName, ut)
    const existing = activeUsers.get(key)
    if (existing) {
      return res.status(409).json({ success: false, error: `你已经在房间 ${existing.roomId} 中${existing.role === 'host' ? '分享' : '观看'}，请先退出` })
    }
    activeUsers.set(key, { role: 'viewer', roomId: req.params.roomId, displayName, registeredAt: Date.now() })
    if (userId) room.viewerKeys.set(userId, key)
  }
  if (userId && displayName) {
    room.viewers.set(userId, displayName)
    room.viewerHeartbeats.set(userId, Date.now())
    if (room.kickedUserIds) room.kickedUserIds.delete(userId)
  }
  if (userId && mid > 0) {
    if (!room.viewerMemberIds) room.viewerMemberIds = new Map()
    room.viewerMemberIds.set(userId, mid)
  }
  if (displayName) room.allViewerNames.add(displayName)
  // 加入后清除该成员的共享邀请与申请记录
  if (mid > 0) {
    try {
      await deleteRoomInvite(mid, rid)
      await pool.execute(`DELETE FROM room_join_requests WHERE room_id = ? AND member_id = ?`, [rid, mid])
    } catch {}
  }
  // Track peak viewers
  const currentViewers = room.viewers.size
  if (currentViewers > room.peakViewers) room.peakViewers = currentViewers

  // Persist viewer name to DB immediately (fixes serverless instance isolation:
  // the instance handling /close may differ from this one and have empty allViewerNames)
  if (displayName) {
    try {
      const [logs] = await pool.execute(
        `SELECT id, viewers FROM share_logs WHERE room_id = ? AND ended_at IS NULL LIMIT 1`,
        [req.params.roomId]
      )
      if (logs.length > 0) {
        const arr = logs[0].viewers ? JSON.parse(logs[0].viewers) : []
        if (!arr.includes(displayName)) {
          arr.push(displayName)
          await pool.execute(
            `UPDATE share_logs SET viewers = ?, peak_viewers = GREATEST(peak_viewers, ?) WHERE id = ?`,
            [JSON.stringify(arr), arr.length, logs[0].id]
          )
        }
      }
    } catch (e) {
      console.error('[ShareLog] Failed to persist viewer:', e.message)
    }
  }

  res.json({
    success: true,
    hostName: room.hostName,
    targetQuality: getTargetQuality(room),
    targetFps: getTargetFps(room),
    hostQuality: room.hostQuality || 1080,
    hostFps: room.hostFps || 60,
  })
})

// Viewer heartbeat - keeps viewer in active list
router.post('/:roomId/heartbeat', (req, res) => {
  const { userId } = req.body
  const room = rooms.get(req.params.roomId)
  if (!room) return res.json({ success: false, exists: false })
  if (userId && room.kickedUserIds?.has(userId)) {
    return res.json({ success: false, kicked: true })
  }
  if (userId) room.viewerHeartbeats.set(userId, Date.now())
  res.json({ success: true })
})

/** 主播踢出观众 */
router.post('/:roomId/kick-viewer', (req, res) => {
  const room = rooms.get(req.params.roomId)
  if (!room || !room.hostName) {
    return res.status(404).json({ success: false, error: '房间不存在' })
  }
  const { userId, hostName, userType } = req.body || {}
  const requesterOk =
    userType === 'admin' ||
    (hostName && String(hostName) === String(room.hostName))
  if (!requesterOk) {
    return res.status(403).json({ success: false, error: '仅共享者可踢人' })
  }
  if (!userId) return res.status(400).json({ success: false, error: '缺少 userId' })
  if (!room.viewers.has(userId)) {
    return res.status(404).json({ success: false, error: '该成员不在观看列表' })
  }

  const name = room.viewers.get(userId)
  room.viewers.delete(userId)
  room.viewerHeartbeats.delete(userId)
  room.viewerMemberIds?.delete(userId)
  const storedKey = room.viewerKeys.get(userId)
  if (storedKey) {
    activeUsers.delete(storedKey)
    room.viewerKeys.delete(userId)
  }
  if (room.qualityPrefs) room.qualityPrefs.delete(userId)
  if (room.fpsPrefs) room.fpsPrefs.delete(userId)
  if (!room.kickedUserIds) room.kickedUserIds = new Set()
  room.kickedUserIds.add(userId)

  res.json({
    success: true,
    kickedUserId: userId,
    kickedName: name,
    viewers: Array.from(room.viewers.values()),
    viewerCount: room.viewers.size,
  })
})

// Get room info (host name + viewer list + mode)
router.get('/:roomId', async (req, res) => {
  if (killedRooms.has(req.params.roomId)) {
    return res.json({ exists: false, hostName: '', viewers: [], killed: true, killedBy: killedRooms.get(req.params.roomId) })
  }
  const room = rooms.get(req.params.roomId)
  if (room?.hostName) {
    return res.json({
      exists: true,
      mode: room.mode || 'peerjs',
      hostName: room.hostName,
      viewers: getActiveViewers(room),
      targetQuality: getTargetQuality(room),
      targetFps: getTargetFps(room),
      hostQuality: room.hostQuality || 1080,
      hostFps: room.hostFps || 60,
    })
  }
  // Serverless 多实例：内存没有时用进行中的 share_logs 兜底
  try {
    const [rows] = await pool.execute(
      `SELECT host_name, mode FROM share_logs WHERE room_id = ? AND ended_at IS NULL LIMIT 1`,
      [req.params.roomId]
    )
    if (rows.length > 0) {
      return res.json({
        exists: true,
        mode: rows[0].mode || 'peerjs',
        hostName: rows[0].host_name || '',
        viewers: [],
        targetQuality: 1080,
        targetFps: 60,
        hostQuality: 1080,
        hostFps: 60,
      })
    }
  } catch {}
  res.json({ exists: false, hostName: '', viewers: [] })
})

// 紫夜自建：清晰度/帧率偏好。主播设置 = 上限；全员按最低偏好编码。
router.post('/:roomId/quality', (req, res) => {
  const room = rooms.get(req.params.roomId)
  if (!room) return res.status(404).json({ success: false, error: '房间不存在' })
  if (!room.qualityPrefs) room.qualityPrefs = new Map()
  if (!room.fpsPrefs) room.fpsPrefs = new Map()
  if (!room.hostQuality) room.hostQuality = 1080
  if (!room.hostFps) room.hostFps = 60

  const key = String(req.body?.userId || req.body?.role || 'anon')
  const isHost = req.body?.role === 'host' || key === 'host'

  if (req.body?.quality !== undefined) {
    const allowedQ = [240, 480, 720, 1080]
    let q = Number(req.body.quality)
    if (!allowedQ.includes(q)) q = 1080
    if (isHost) {
      room.hostQuality = q
      // 观众偏好若超过新上限，截断
      for (const [k, v] of room.qualityPrefs.entries()) {
        if (k !== 'host' && v > q) room.qualityPrefs.set(k, q)
      }
    } else {
      q = Math.min(q, room.hostQuality)
    }
    room.qualityPrefs.set(key, q)
  }

  if (req.body?.fps !== undefined) {
    const allowedF = [30, 60]
    let f = Number(req.body.fps)
    if (!allowedF.includes(f)) f = 60
    if (isHost) {
      room.hostFps = f
      for (const [k, v] of room.fpsPrefs.entries()) {
        if (k !== 'host' && v > f) room.fpsPrefs.set(k, f)
      }
    } else {
      f = Math.min(f, room.hostFps)
    }
    room.fpsPrefs.set(key, f)
  }

  res.json({
    success: true,
    targetQuality: getTargetQuality(room),
    targetFps: getTargetFps(room),
    hostQuality: room.hostQuality,
    hostFps: room.hostFps,
  })
})

// Viewer leaves
router.post('/:roomId/leave', (req, res) => {
  const { userId, displayName, userType: ut } = req.body
  const room = rooms.get(req.params.roomId)
  if (room && userId) {
    room.viewers.delete(userId)
    room.viewerHeartbeats.delete(userId)
    room.viewerMemberIds?.delete(userId)
    const storedKey = room.viewerKeys.get(userId)
    if (storedKey) { activeUsers.delete(storedKey); room.viewerKeys.delete(userId) }
    if (room.qualityPrefs) room.qualityPrefs.delete(userId)
    if (room.fpsPrefs) room.fpsPrefs.delete(userId)
  }
  // Fallback: try key from params
  if (displayName) {
    const key = userKey(displayName, ut)
    const info = activeUsers.get(key)
    if (info && info.roomId === req.params.roomId) activeUsers.delete(key)
  }
  res.json({ success: true })
})

// Host closes room
router.post('/:roomId/close', async (req, res) => {
  const { displayName, userType: ut } = req.body || {}
  const room = rooms.get(req.params.roomId)
  if (room) {
    if (room.hostKey) activeUsers.delete(room.hostKey)
    room.viewerKeys.forEach((vKey) => activeUsers.delete(vKey))
    // Update share log with end time, peak viewers, and viewer names
    try {
      // viewers already persisted incrementally; just close with peak
      await pool.execute(
        `UPDATE share_logs SET ended_at = NOW(), peak_viewers = GREATEST(peak_viewers, ?) WHERE room_id = ? AND ended_at IS NULL`,
        [room.peakViewers, req.params.roomId]
      )
    } catch {}
  } else {
    // Room not in memory — clean up by key and room_id
    if (displayName) {
      const key = userKey(displayName, ut)
      activeUsers.delete(key)
    }
    try {
      await pool.execute(
        `UPDATE share_logs SET ended_at = NOW() WHERE room_id = ? AND ended_at IS NULL`,
        [req.params.roomId]
      )
    } catch {}
  }
  clearInvitesForRoom(req.params.roomId)
  rooms.delete(req.params.roomId)
  res.json({ success: true })
})

export default router
