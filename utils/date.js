/**
 * 规范化为 MySQL DATE 字符串 (YYYY-MM-DD)，不做 UTC 偏移
 */
export function toMySQLDate(value) {
  if (value == null || value === '') return null

  const str = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.slice(0, 10)
  }

  const date = value instanceof Date ? value : new Date(str)
  if (Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date)
}

/**
 * 将库内 DATETIME（按上海墙钟存储的无时区字符串）解析为正确的绝对时间。
 * 避免服务器在 UTC 时区时把 "19:00:00" 当成 19:00 UTC。
 */
export function parseShanghaiDateTime(value) {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // dateStrings:true 下一般不会走到这里；若已是 Date，按上海部件重解更稳
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(value)
    const get = (t) => parts.find((p) => p.type === t)?.value
    const y = Number(get('year'))
    const mo = Number(get('month'))
    const d = Number(get('day'))
    const h = Number(get('hour'))
    const mi = Number(get('minute'))
    const se = Number(get('second') || 0)
    if ([y, mo, d, h, mi, se].every((n) => Number.isFinite(n))) {
      return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, se))
    }
  }
  const s = String(value).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  const se = Number(m[6] || 0)
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, se))
}
