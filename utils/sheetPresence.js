/** 表格在场状态：进程内存，不落库。心跳约 20s，超时 45s 剔除。 */

const TTL_MS = 45_000
/** workbookId -> Map(sessionKey, entry) */
const rooms = new Map()

function pruneRoom(room) {
  const now = Date.now()
  for (const [key, entry] of room) {
    if (now - entry.at > TTL_MS) room.delete(key)
  }
}

/**
 * @param {number|string} workbookId
 * @param {{ sessionId: string, userId: number|string, role: 'admin'|'student', name: string, editing?: boolean }} actor
 */
export function touchSheetPresence(workbookId, actor) {
  const wid = String(workbookId)
  let room = rooms.get(wid)
  if (!room) {
    room = new Map()
    rooms.set(wid, room)
  }
  const sessionId = String(actor.sessionId || '').slice(0, 64) || 'default'
  const key = `${actor.role}:${actor.userId}:${sessionId}`
  room.set(key, {
    key,
    userId: actor.userId,
    role: actor.role === 'admin' ? 'admin' : 'student',
    name: String(actor.name || '未知').slice(0, 64),
    editing: !!actor.editing,
    at: Date.now(),
  })
  pruneRoom(room)
  if (room.size === 0) rooms.delete(wid)
  return listSheetPresence(wid)
}

export function leaveSheetPresence(workbookId, actor) {
  const wid = String(workbookId)
  const room = rooms.get(wid)
  if (!room) return []
  const sessionId = String(actor.sessionId || '').slice(0, 64) || 'default'
  const key = `${actor.role}:${actor.userId}:${sessionId}`
  room.delete(key)
  pruneRoom(room)
  if (room.size === 0) rooms.delete(wid)
  return listSheetPresence(wid)
}

export function listSheetPresence(workbookId) {
  const wid = String(workbookId)
  const room = rooms.get(wid)
  if (!room) return []
  pruneRoom(room)
  if (room.size === 0) {
    rooms.delete(wid)
    return []
  }
  return Array.from(room.values())
    .sort((a, b) => {
      if (a.editing !== b.editing) return a.editing ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    })
    .map(({ key, userId, role, name, editing, at }) => ({
      key,
      userId,
      role,
      name,
      editing,
      at,
    }))
}
