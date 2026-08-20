/**
 * 撤销助教时：清除该成员作为助教产生的全部归属与申请数据。
 */

async function safeExec(connOrPool, sql, params = []) {
  try {
    await connOrPool.query(sql, params)
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return
    throw e
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} assistantMemberId
 */
export async function clearAssistantRoleData(pool, assistantMemberId) {
  const id = Number(assistantMemberId)
  if (!id) return

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await safeExec(conn, 'DELETE FROM assistant_student_assignments WHERE assistant_member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM assistant_daily_assignments WHERE assistant_member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM assistant_permissions WHERE assistant_member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM pending_member_creates WHERE assistant_member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM pending_stage_promotions WHERE assistant_member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM pending_member_edits WHERE assistant_member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM pending_black_points WHERE assistant_member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM pending_leaves WHERE assistant_member_id = ?', [id])
    await safeExec(
      conn,
      'UPDATE quit_approvals SET source_assistant_id = NULL WHERE source_assistant_id = ?',
      [id]
    )

    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

/**
 * 清理「已不是助教」但仍残留的归属 / 申请（修复历史撤销未清数据）
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} assistantRoleName 阶段名「紫夜助教」
 */
export async function cleanupOrphanedAssistantData(pool, assistantRoleName = '紫夜助教') {
  const notAsst = `(COALESCE(m.is_ziye_assistant, 0) = 0 AND m.stage_role <> ?)`
  const join = `INNER JOIN members m ON m.id = t.assistant_member_id WHERE ${notAsst}`

  await safeExec(
    pool,
    `DELETE t FROM assistant_student_assignments t ${join}`,
    [assistantRoleName]
  )
  await safeExec(
    pool,
    `DELETE t FROM assistant_daily_assignments t ${join}`,
    [assistantRoleName]
  )
  await safeExec(
    pool,
    `DELETE t FROM assistant_permissions t ${join}`,
    [assistantRoleName]
  )
  await safeExec(
    pool,
    `DELETE t FROM pending_member_creates t ${join}`,
    [assistantRoleName]
  )
  await safeExec(
    pool,
    `DELETE t FROM pending_stage_promotions t ${join}`,
    [assistantRoleName]
  )
  await safeExec(
    pool,
    `DELETE t FROM pending_member_edits t ${join}`,
    [assistantRoleName]
  )
  await safeExec(
    pool,
    `DELETE t FROM pending_black_points t ${join}`,
    [assistantRoleName]
  )
  await safeExec(
    pool,
    `DELETE t FROM pending_leaves t ${join}`,
    [assistantRoleName]
  )
}
