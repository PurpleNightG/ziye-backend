/**
 * 登录失败限流（内存）：同一 IP / 用户名短时间失败过多则暂时拒绝
 */

const buckets = new Map()

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS = 8
const LOCK_MS = 30 * 60 * 1000

function key(ip, username) {
  return `${ip || '?'}::${String(username || '').toLowerCase()}`
}

function prune(now) {
  if (buckets.size < 500) return
  for (const [k, v] of buckets) {
    if (v.lockUntil && v.lockUntil < now && (!v.windowStart || now - v.windowStart > WINDOW_MS)) {
      buckets.delete(k)
    }
  }
}

export function checkLoginAllowed(ip, username) {
  const now = Date.now()
  prune(now)
  const k = key(ip, username)
  const row = buckets.get(k)
  if (!row) return { ok: true }
  if (row.lockUntil && row.lockUntil > now) {
    const mins = Math.ceil((row.lockUntil - now) / 60000)
    return { ok: false, message: `登录失败过多，请 ${mins} 分钟后再试` }
  }
  return { ok: true }
}

export function recordLoginFailure(ip, username) {
  const now = Date.now()
  const k = key(ip, username)
  let row = buckets.get(k)
  if (!row || now - row.windowStart > WINDOW_MS) {
    row = { windowStart: now, fails: 0, lockUntil: 0 }
  }
  row.fails += 1
  if (row.fails >= MAX_FAILS) {
    row.lockUntil = now + LOCK_MS
    row.fails = 0
    row.windowStart = now
  }
  buckets.set(k, row)
}

export function recordLoginSuccess(ip, username) {
  buckets.delete(key(ip, username))
}
