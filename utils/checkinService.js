/**
 * 学员每日签到（学习通式签到码）
 */
import { pool } from '../config/database.js'
import { toMySQLDate } from './date.js'
import { normalizeIp, isLoopbackIp } from './clientIp.js'

export function shanghaiToday() {
  return (
    toMySQLDate(new Date()) ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  )
}

export async function ensureCheckinTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_checkin_days (
      id INT AUTO_INCREMENT PRIMARY KEY,
      checkin_date DATE NOT NULL COMMENT '上海日历日',
      code CHAR(4) NOT NULL COMMENT '4位签到码',
      status ENUM('active','stopped') NOT NULL DEFAULT 'active',
      created_by_admin_id INT NULL,
      created_by_name VARCHAR(100) NULL,
      stopped_by_admin_id INT NULL,
      stopped_by_name VARCHAR(100) NULL,
      stopped_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_checkin_date (checkin_date),
      INDEX idx_checkin_status (status, checkin_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每日签到任务'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_checkin_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      day_id INT NOT NULL,
      checkin_date DATE NOT NULL,
      member_id INT NOT NULL,
      member_name VARCHAR(100) NULL,
      source ENUM('self','proxy_admin','proxy_assistant') NOT NULL DEFAULT 'self',
      proxy_user_type ENUM('admin','assistant') NULL,
      proxy_user_id INT NULL,
      proxy_name VARCHAR(100) NULL,
      previous_last_training_date DATE NULL COMMENT '签到前的最后新训日期，取消时回退用',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_day_member (day_id, member_id),
      INDEX idx_checkin_rec_date (checkin_date),
      INDEX idx_checkin_rec_member (member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='签到完成记录'
  `)

  try {
    await pool.query(`
      ALTER TABLE training_checkin_records
      ADD COLUMN previous_last_training_date DATE NULL
        COMMENT '签到前的最后新训日期，取消时回退用'
        AFTER proxy_name
    `)
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }

  try {
    await pool.query(`
      ALTER TABLE training_checkin_records
      ADD COLUMN client_ip VARCHAR(45) NULL
        COMMENT '学员自助签到有效 IP（界面不展示，供 AI 分析）'
        AFTER previous_last_training_date
    `)
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_checkin_attempts (
      member_id INT NOT NULL,
      attempt_date DATE NOT NULL,
      fail_count INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (member_id, attempt_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学员签到当日错误次数'
  `)
}

export const CHECKIN_MAX_FAILS = 5

export async function getStudentAttemptInfo(memberId, date = null) {
  await ensureCheckinTables()
  const d = toMySQLDate(date) || shanghaiToday()
  const [[row]] = await pool.query(
    `SELECT fail_count FROM training_checkin_attempts
     WHERE member_id = ? AND attempt_date = ? LIMIT 1`,
    [memberId, d]
  )
  const failCount = Number(row?.fail_count) || 0
  const locked = failCount >= CHECKIN_MAX_FAILS
  return {
    fail_count: failCount,
    max_fails: CHECKIN_MAX_FAILS,
    remaining_attempts: Math.max(0, CHECKIN_MAX_FAILS - failCount),
    locked,
  }
}

async function bumpFailAttempt(memberId, date) {
  await pool.query(
    `INSERT INTO training_checkin_attempts (member_id, attempt_date, fail_count)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE fail_count = fail_count + 1`,
    [memberId, date]
  )
  return getStudentAttemptInfo(memberId, date)
}

async function clearFailAttempts(memberId, date) {
  await pool.query(
    `DELETE FROM training_checkin_attempts WHERE member_id = ? AND attempt_date = ?`,
    [memberId, date]
  )
}

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000))
}

export async function getDayByDate(date) {
  const d = toMySQLDate(date) || shanghaiToday()
  const [[row]] = await pool.query(
    `SELECT * FROM training_checkin_days WHERE checkin_date = ? LIMIT 1`,
    [d]
  )
  return row || null
}

/** 获取或创建当日签到任务（仅管理端创建时传 actor） */
export async function getOrCreateTodayDay(actor = null) {
  await ensureCheckinTables()
  const today = shanghaiToday()
  let day = await getDayByDate(today)
  if (day) return day
  if (!actor) return null
  const code = randomCode()
  try {
    const [result] = await pool.query(
      `INSERT INTO training_checkin_days
        (checkin_date, code, status, created_by_admin_id, created_by_name)
       VALUES (?, ?, 'active', ?, ?)`,
      [today, code, actor.id || null, actor.name || null]
    )
    day = await getDayByDate(today)
    if (!day) {
      day = {
        id: result.insertId,
        checkin_date: today,
        code,
        status: 'active',
        created_by_admin_id: actor.id,
        created_by_name: actor.name,
      }
    }
    return day
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return getDayByDate(today)
    throw e
  }
}

export async function regenerateCode(dayId, actor) {
  const code = randomCode()
  await pool.query(
    `UPDATE training_checkin_days
     SET code = ?, status = 'active',
         stopped_by_admin_id = NULL, stopped_by_name = NULL, stopped_at = NULL
     WHERE id = ?`,
    [code, dayId]
  )
  return getDayById(dayId)
}

export async function stopDay(dayId, actor) {
  await pool.query(
    `UPDATE training_checkin_days
     SET status = 'stopped',
         stopped_by_admin_id = ?, stopped_by_name = ?, stopped_at = NOW()
     WHERE id = ?`,
    [actor?.id || null, actor?.name || null, dayId]
  )
  return getDayById(dayId)
}

export async function getDayById(id) {
  const [[row]] = await pool.query(
    `SELECT * FROM training_checkin_days WHERE id = ? LIMIT 1`,
    [id]
  )
  return row || null
}

export async function countRecords(dayId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS c FROM training_checkin_records WHERE day_id = ?`,
    [dayId]
  )
  return Number(row?.c) || 0
}

export async function listRecords(dayId) {
  const [rows] = await pool.query(
    `SELECT r.id, r.day_id, r.checkin_date, r.member_id, r.member_name, r.source,
            r.proxy_user_type, r.proxy_user_id, r.proxy_name, r.previous_last_training_date,
            r.created_at, m.qq, m.stage_role, m.avatar, m.status AS member_status
     FROM training_checkin_records r
     LEFT JOIN members m ON m.id = r.member_id
     WHERE r.day_id = ?
     ORDER BY r.created_at DESC, r.id DESC`,
    [dayId]
  )
  return rows
}

export async function listRecentDays(limit = 30) {
  const [rows] = await pool.query(
    `SELECT d.*,
       (SELECT COUNT(*) FROM training_checkin_records r WHERE r.day_id = d.id) AS checked_count
     FROM training_checkin_days d
     ORDER BY d.checkin_date DESC
     LIMIT ?`,
    [Math.min(90, Math.max(1, Number(limit) || 30))]
  )
  return rows
}

/**
 * 学员自助签到：校验码 → 写记录 → 更新 last_training_date
 * @param {{ clientIp?: string|null }} [opts]
 */
export async function studentSelfCheckin(member, code, opts = {}) {
  await ensureCheckinTables()
  const today = shanghaiToday()
  if (!member?.id || member.status === '已退队') {
    return { ok: false, status: 403, message: '账号不可用' }
  }
  if (member.status === '请假中') {
    return { ok: false, status: 400, message: '请假中无法签到' }
  }

  const attempt = await getStudentAttemptInfo(member.id, today)
  if (attempt.locked) {
    return {
      ok: false,
      status: 429,
      message: '今日连续输错已达上限，无法再次输入',
      data: attempt,
    }
  }

  const day = await getDayByDate(today)
  if (!day) {
    return { ok: false, status: 404, message: '今日尚无签到任务', data: attempt }
  }
  if (day.status !== 'active') {
    return { ok: false, status: 400, message: '今日签到已停止（未开训）', data: attempt }
  }
  const input = String(code || '').trim()
  if (!/^\d{4}$/.test(input)) {
    return { ok: false, status: 400, message: '请输入4位签到码', data: attempt }
  }
  if (input !== String(day.code)) {
    const next = await bumpFailAttempt(member.id, today)
    return {
      ok: false,
      status: 400,
      message: next.locked
        ? '签到码不正确，今日错误次数已达上限，无法再次输入'
        : `签到码不正确，还可尝试 ${next.remaining_attempts} 次`,
      data: next,
    }
  }

  const [[fresh]] = await pool.query(
    `SELECT id, nickname, username, last_training_date FROM members WHERE id = ? LIMIT 1`,
    [member.id]
  )
  const previous = toMySQLDate(fresh?.last_training_date) || null
  const clientIp = opts.clientIp ? String(opts.clientIp).slice(0, 45) : null

  await pool.query('UPDATE members SET last_training_date = ? WHERE id = ?', [today, member.id])

  await pool.query(
    `INSERT INTO training_checkin_records
      (day_id, checkin_date, member_id, member_name, source, proxy_user_type, proxy_user_id, proxy_name, previous_last_training_date, client_ip)
     VALUES (?, ?, ?, ?, 'self', NULL, NULL, NULL, ?, ?)
     ON DUPLICATE KEY UPDATE
       member_name = VALUES(member_name),
       source = 'self',
       proxy_user_type = NULL,
       proxy_user_id = NULL,
       proxy_name = NULL,
       previous_last_training_date = IFNULL(training_checkin_records.previous_last_training_date, VALUES(previous_last_training_date)),
       client_ip = COALESCE(VALUES(client_ip), training_checkin_records.client_ip),
       created_at = CURRENT_TIMESTAMP`,
    [
      day.id,
      today,
      member.id,
      fresh?.nickname || fresh?.username || member.nickname || null,
      previous,
      clientIp,
    ]
  )

  await clearFailAttempts(member.id, today)

  return {
    ok: true,
    data: {
      checkin_date: today,
      last_training_date: today,
      day_id: day.id,
    },
  }
}

/**
 * 管理/助教修改 last_training_date 后：若该日存在签到任务，则写入代签记录
 */
export async function syncProxyCheckinFromTrainingDate(memberId, trainingDate, proxy) {
  await ensureCheckinTables()
  const date = toMySQLDate(trainingDate)
  if (!date || !memberId) return null

  const day = await getDayByDate(date)
  if (!day) return null

  const [[member]] = await pool.query(
    `SELECT id, nickname, status, last_training_date FROM members WHERE id = ? LIMIT 1`,
    [memberId]
  )
  if (!member || member.status === '已退队') return null

  // 代签：尽量写入 previous（调用方可传入改日期前的值）
  const source = proxy?.type === 'assistant' ? 'proxy_assistant' : 'proxy_admin'
  const prev =
    toMySQLDate(proxy?.previousLastTrainingDate) ||
    null
  await pool.query(
    `INSERT INTO training_checkin_records
      (day_id, checkin_date, member_id, member_name, source, proxy_user_type, proxy_user_id, proxy_name, previous_last_training_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         member_name = VALUES(member_name),
         source = IF(training_checkin_records.source = 'self', 'self', VALUES(source)),
         proxy_user_type = IF(training_checkin_records.source = 'self', proxy_user_type, VALUES(proxy_user_type)),
         proxy_user_id = IF(training_checkin_records.source = 'self', proxy_user_id, VALUES(proxy_user_id)),
         proxy_name = IF(training_checkin_records.source = 'self', proxy_name, VALUES(proxy_name)),
         previous_last_training_date = IFNULL(training_checkin_records.previous_last_training_date, VALUES(previous_last_training_date))`,
    [
      day.id,
      date,
      member.id,
      member.nickname || null,
      source,
      proxy?.type === 'assistant' ? 'assistant' : 'admin',
      proxy?.id || null,
      proxy?.name || null,
      prev,
    ]
  )
  return day
}

/**
 * 管理取消某条签到记录，并按规则回退 last_training_date：
 * - 若成员当前 last_training_date == 该签到日：
 *   优先改为「其余签到记录中的最晚日期」；没有则回退到 previous_last_training_date（可为空）
 * - 若当前 last_training_date 已不是该日（事后被改过）：只删记录，不动日期
 */
export async function cancelCheckinRecord(recordId) {
  await ensureCheckinTables()
  const id = Number(recordId)
  if (!id) return { ok: false, status: 400, message: '记录无效' }

  const [[rec]] = await pool.query(
    `SELECT * FROM training_checkin_records WHERE id = ? LIMIT 1`,
    [id]
  )
  if (!rec) return { ok: false, status: 404, message: '签到记录不存在' }

  const checkinDate = toMySQLDate(rec.checkin_date)
  const previous = toMySQLDate(rec.previous_last_training_date)

  const [[member]] = await pool.query(
    `SELECT id, nickname, last_training_date FROM members WHERE id = ? LIMIT 1`,
    [rec.member_id]
  )
  if (!member) return { ok: false, status: 404, message: '成员不存在' }

  const current = toMySQLDate(member.last_training_date)

  await pool.query(`DELETE FROM training_checkin_records WHERE id = ?`, [id])

  const [[other]] = await pool.query(
    `SELECT MAX(checkin_date) AS max_date
     FROM training_checkin_records
     WHERE member_id = ?`,
    [rec.member_id]
  )
  const otherMax = toMySQLDate(other?.max_date)

  let restoredTo = current
  let dateChanged = false

  if (!current || current === checkinDate) {
    restoredTo = otherMax || previous || null
    await pool.query(`UPDATE members SET last_training_date = ? WHERE id = ?`, [
      restoredTo,
      rec.member_id,
    ])
    dateChanged = true
  }

  return {
    ok: true,
    data: {
      record_id: id,
      member_id: rec.member_id,
      member_name: member.nickname || rec.member_name,
      cancelled_date: checkinDate,
      last_training_date: restoredTo,
      date_changed: dateChanged,
      restored_from_other_checkin: dateChanged && !!otherMax,
      restored_from_previous: dateChanged && !otherMax && previous != null,
    },
  }
}

export async function getMemberCheckinStatus(memberId, date = null) {
  const d = toMySQLDate(date) || shanghaiToday()
  const [[row]] = await pool.query(
    `SELECT r.id, r.day_id, r.checkin_date, r.member_id, r.member_name, r.source,
            r.proxy_user_type, r.proxy_user_id, r.proxy_name, r.created_at
     FROM training_checkin_records r
     WHERE r.member_id = ? AND r.checkin_date = ?
     LIMIT 1`,
    [memberId, d]
  )
  const day = await getDayByDate(d)
  return {
    date: d,
    day_status: day?.status || null,
    has_task: !!day,
    checked: !!row,
    record: row || null,
  }
}

/** AI / 统计：近期「签到活跃度」摘要（以签到记录为主，不把状态当活跃度） */
export async function buildActivitySummary({ days = 14 } = {}) {
  const n = Math.min(60, Math.max(1, Number(days) || 14))
  const today = shanghaiToday()

  const [[checkinUnique]] = await pool.query(
    `SELECT COUNT(DISTINCT member_id) AS c FROM training_checkin_records
     WHERE checkin_date >= DATE_SUB(?, INTERVAL ? DAY)`,
    [today, n]
  )
  const [[checkinTotal]] = await pool.query(
    `SELECT COUNT(*) AS c FROM training_checkin_records
     WHERE checkin_date >= DATE_SUB(?, INTERVAL ? DAY)`,
    [today, n]
  )
  const [[daysWithRecords]] = await pool.query(
    `SELECT COUNT(DISTINCT checkin_date) AS c FROM training_checkin_records
     WHERE checkin_date >= DATE_SUB(?, INTERVAL ? DAY)`,
    [today, n]
  )
  const [[daysWithTask]] = await pool.query(
    `SELECT COUNT(*) AS c FROM training_checkin_days
     WHERE checkin_date >= DATE_SUB(?, INTERVAL ? DAY)`,
    [today, n]
  )
  const [[selfCheckins]] = await pool.query(
    `SELECT COUNT(*) AS c FROM training_checkin_records
     WHERE checkin_date >= DATE_SUB(?, INTERVAL ? DAY) AND source = 'self'`,
    [today, n]
  )
  const [[proxyCheckins]] = await pool.query(
    `SELECT COUNT(*) AS c FROM training_checkin_records
     WHERE checkin_date >= DATE_SUB(?, INTERVAL ? DAY) AND source <> 'self'`,
    [today, n]
  )

  const todayDay = await getDayByDate(today)
  let todayChecked = 0
  if (todayDay) todayChecked = await countRecords(todayDay.id)

  const [topRecent] = await pool.query(
    `SELECT checkin_date, COUNT(*) AS c
     FROM training_checkin_records
     WHERE checkin_date >= DATE_SUB(?, INTERVAL ? DAY)
     GROUP BY checkin_date
     ORDER BY checkin_date DESC`,
    [today, n]
  )

  const unique = Number(checkinUnique?.c) || 0
  const total = Number(checkinTotal?.c) || 0
  const activeDays = Number(daysWithRecords?.c) || 0
  const avgPerActiveDay = activeDays > 0 ? Math.round((total / activeDays) * 10) / 10 : 0

  /** 相邻签到日 IP 变化（仅自助签到；不把具体 IP 交给前端，只给 AI 摘要用） */
  let ipChangeSuspects = []
  try {
    const [ipRows] = await pool.query(
      `SELECT member_id, member_name, checkin_date, client_ip
       FROM training_checkin_records
       WHERE source = 'self'
         AND checkin_date >= DATE_SUB(?, INTERVAL ? DAY)
         AND client_ip IS NOT NULL AND client_ip != ''
       ORDER BY member_id ASC, checkin_date ASC, id ASC`,
      [today, n]
    )
    const byMember = new Map()
    for (const row of ipRows || []) {
      const mid = Number(row.member_id)
      if (!byMember.has(mid)) byMember.set(mid, [])
      byMember.get(mid).push(row)
    }
    for (const [, rows] of byMember) {
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]
        const cur = rows[i]
        const a = normalizeIp(prev.client_ip)
        const b = normalizeIp(cur.client_ip)
        if (!a || !b || a === b) continue
        if (isLoopbackIp(a) && isLoopbackIp(b)) continue
        const d0 = toMySQLDate(prev.checkin_date)
        const d1 = toMySQLDate(cur.checkin_date)
        ipChangeSuspects.push({
          member_name: cur.member_name || prev.member_name,
          from_date: d0,
          to_date: d1,
          note: '相邻自助签到日的网络环境不一致，需排查是否代签/换设备',
        })
      }
    }
    ipChangeSuspects = ipChangeSuspects.slice(0, 20)
  } catch {
    ipChangeSuspects = []
  }

  /** 已登记的管理/助教代签（明确是谁被代签） */
  let proxyRecords = []
  try {
    const [rows] = await pool.query(
      `SELECT member_name, checkin_date, source, proxy_name
       FROM training_checkin_records
       WHERE source <> 'self'
         AND checkin_date >= DATE_SUB(?, INTERVAL ? DAY)
       ORDER BY checkin_date DESC, id DESC
       LIMIT 30`,
      [today, n]
    )
    proxyRecords = (rows || []).map((r) => ({
      member_name: r.member_name,
      checkin_date: toMySQLDate(r.checkin_date),
      source: r.source,
      proxy_name: r.proxy_name || null,
    }))
  } catch {
    proxyRecords = []
  }

  const suspectNames = [
    ...new Set(ipChangeSuspects.map((s) => s.member_name).filter(Boolean)),
  ]
  const proxyMemberNames = [
    ...new Set(proxyRecords.map((s) => s.member_name).filter(Boolean)),
  ]

  return {
    today,
    window_days: n,
    /** 签到维度（活跃度主数据） */
    checkin_unique_members: unique,
    checkin_total: total,
    checkin_days_with_records: activeDays,
    checkin_task_days: Number(daysWithTask?.c) || 0,
    checkin_self: Number(selfCheckins?.c) || 0,
    checkin_proxy: Number(proxyCheckins?.c) || 0,
    checkin_avg_per_active_day: avgPerActiveDay,
    checkin_by_day: topRecent,
    today_checkin: todayDay
      ? {
          status: todayDay.status,
          checked_count: todayChecked,
        }
      : null,
    /** 可疑代签线索（不含具体 IP；必须用 member_name 点名） */
    ip_change_suspects: ipChangeSuspects,
    ip_change_suspect_count: ipChangeSuspects.length,
    ip_change_suspect_names: suspectNames,
    /** 系统已记录的代签（管理/助教） */
    proxy_checkins: proxyRecords,
    proxy_member_names: proxyMemberNames,
  }
}
