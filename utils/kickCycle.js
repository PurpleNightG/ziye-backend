/**
 * 踢人周期：例如周一踢人、提前 3 天（周五起）提醒。
 * kickWeekday: 1=周一 … 7=周日（ISO）
 */

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function weekdayLabel(isoWeekday) {
  return WEEKDAY_LABELS[isoWeekday] || `周${isoWeekday}`
}

/** @param {string} todayIso YYYY-MM-DD（与 MySQL CURDATE 一致） */
export function getKickCycleInfo(todayIso, kickWeekday = 1, leadDays = 3) {
  const kick = Math.min(7, Math.max(1, Math.floor(Number(kickWeekday) || 1)))
  const lead = Math.min(14, Math.max(0, Math.floor(Number(leadDays) || 3)))

  const parts = String(todayIso).slice(0, 10).split('-').map(Number)
  const y = parts[0]
  const m = parts[1]
  const d = parts[2]
  const today = new Date(Date.UTC(y, m - 1, d))
  const jsDay = today.getUTCDay() // 0=Sun
  const isoDay = jsDay === 0 ? 7 : jsDay

  // 距下一个踢人日的天数（今天就是踢人日则为 0）
  const daysUntilKick = (kick - isoDay + 7) % 7

  const kickDate = new Date(today)
  kickDate.setUTCDate(kickDate.getUTCDate() + daysUntilKick)

  const windowStart = new Date(kickDate)
  windowStart.setUTCDate(windowStart.getUTCDate() - lead)

  const inWindow = today.getTime() >= windowStart.getTime() && today.getTime() <= kickDate.getTime()

  const fmt = (dt) => {
    const yy = dt.getUTCFullYear()
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(dt.getUTCDate()).padStart(2, '0')
    return `${yy}-${mm}-${dd}`
  }

  return {
    kickWeekday: kick,
    leadDays: lead,
    daysUntilKick,
    kickDate: fmt(kickDate),
    windowStart: fmt(windowStart),
    inWindow,
    kickWeekdayLabel: weekdayLabel(kick),
  }
}
