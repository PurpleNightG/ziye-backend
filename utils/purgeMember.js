/**
 * 彻底抹除已退队成员及其全部关联数据（含曾为助教时的申请/归属）。
 * 仅允许 status = '已退队'。
 */

async function safeExec(conn, sql, params = []) {
  try {
    await conn.query(sql, params)
  } catch (e) {
    // 表不存在 / 无此列时跳过，兼容历史库
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return
    throw e
  }
}

/**
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} pool
 * @param {number} memberId
 */
export async function purgeArchivedMember(pool, memberId) {
  const id = Number(memberId)
  if (!id) {
    const err = new Error('无效的成员 ID')
    err.status = 400
    throw err
  }

  const [[member]] = await pool.query(
    'SELECT id, nickname, qq, status FROM members WHERE id = ? LIMIT 1',
    [id]
  )
  if (!member) {
    const err = new Error('成员不存在')
    err.status = 404
    throw err
  }
  if (member.status !== '已退队') {
    const err = new Error('仅可彻底删除已退队归档成员')
    err.status = 400
    throw err
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // —— 作为学员 / 普通成员 ——
    await safeExec(conn, 'DELETE FROM leave_applications WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM leave_records WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM black_point_records WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM reminder_list WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM quit_approvals WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM retention_records WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM student_course_progress WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM assessments WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM assessment_applications WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM attendance_reminder_ignores WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM attendance_reminder_overrides WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM survey_claims WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM survey_responses WHERE member_id = ?', [id])
    // 反作弊：先清会话子表，再会话，再配置
    await safeExec(
      conn,
      `DELETE ml FROM monitor_logs ml
       INNER JOIN exam_sessions es ON es.id = ml.exam_session_id
       INNER JOIN exam_configs ec ON ec.id = es.config_id
       WHERE ec.member_id = ?`,
      [id]
    )
    await safeExec(
      conn,
      `DELETE ss FROM screenshots ss
       INNER JOIN exam_sessions es ON es.id = ss.exam_session_id
       INNER JOIN exam_configs ec ON ec.id = es.config_id
       WHERE ec.member_id = ?`,
      [id]
    )
    await safeExec(
      conn,
      `DELETE fs FROM file_snapshots fs
       INNER JOIN exam_sessions es ON es.id = fs.exam_session_id
       INNER JOIN exam_configs ec ON ec.id = es.config_id
       WHERE ec.member_id = ?`,
      [id]
    )
    await safeExec(
      conn,
      `DELETE cl FROM client_logs cl
       INNER JOIN exam_sessions es ON es.id = cl.session_id
       INNER JOIN exam_configs ec ON ec.id = es.config_id
       WHERE ec.member_id = ?`,
      [id]
    )
    await safeExec(
      conn,
      `DELETE es FROM exam_sessions es
       INNER JOIN exam_configs ec ON ec.id = es.config_id
       WHERE ec.member_id = ?`,
      [id]
    )
    await safeExec(conn, 'DELETE FROM exam_configs WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM dll_whitelist WHERE member_id = ?', [id])

    // 会议 / 屏幕共享（先清此人作为助教发起人的引用，再删本人退队记录）
    await safeExec(conn, 'UPDATE quit_approvals SET source_assistant_id = NULL WHERE source_assistant_id = ?', [id])
    await safeExec(conn, 'DELETE FROM meeting_invites WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM meeting_join_requests WHERE member_id = ?', [id])
    await safeExec(conn, 'UPDATE screen_share_guest_codes SET created_by_member_id = NULL WHERE created_by_member_id = ?', [id])

    // —— 作为助教：申请、归属、权限 ——
    await safeExec(conn, 'DELETE FROM assistant_student_assignments WHERE assistant_member_id = ? OR student_member_id = ?', [id, id])
    await safeExec(conn, 'DELETE FROM assistant_daily_assignments WHERE assistant_member_id = ? OR student_member_id = ?', [id, id])
    await safeExec(conn, 'DELETE FROM assistant_permissions WHERE assistant_member_id = ?', [id])
    await safeExec(
      conn,
      `DELETE FROM pending_member_creates
       WHERE assistant_member_id = ? OR created_member_id = ? OR restore_member_id = ?`,
      [id, id, id]
    )
    await safeExec(
      conn,
      'DELETE FROM pending_stage_promotions WHERE assistant_member_id = ? OR student_member_id = ?',
      [id, id]
    )
    await safeExec(
      conn,
      'DELETE FROM pending_member_edits WHERE assistant_member_id = ? OR student_member_id = ?',
      [id, id]
    )
    await safeExec(
      conn,
      'DELETE FROM pending_black_points WHERE assistant_member_id = ? OR student_member_id = ?',
      [id, id]
    )
    await safeExec(
      conn,
      'DELETE FROM pending_leaves WHERE assistant_member_id = ? OR student_member_id = ?',
      [id, id]
    )

    // 意见箱等可选表
    await safeExec(conn, 'DELETE FROM opinion_box WHERE member_id = ?', [id])
    await safeExec(conn, 'DELETE FROM login_sessions WHERE user_type = ? AND user_id = ?', ['student', id])
    await safeExec(conn, 'DELETE FROM login_sessions WHERE user_type = ? AND user_id = ?', ['member', id])

    await conn.query('DELETE FROM members WHERE id = ? AND status = ?', [id, '已退队'])

    await conn.commit()
    return { id: member.id, nickname: member.nickname, qq: member.qq }
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}
