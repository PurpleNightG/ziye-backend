import express from 'express'
import { pool } from '../config/database.js'
import { ensurePhase3ReachedAt } from '../utils/attendanceReminder.js'
import { purgeArchivedMember } from '../utils/purgeMember.js'
import bcrypt from 'bcryptjs'
import { toMySQLDate } from '../utils/date.js'
import { authenticateRequest } from '../utils/authGate.js'

const router = express.Router()

// 学员端：自己的成员资料（不含密码）
router.get('/me', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, { requireType: 'student' })
    if (!auth) {
      return res.status(401).json({ success: false, message: '未登录或会话已失效，请重新登录' })
    }

    const [rows] = await pool.query(
      `SELECT
        id, nickname, qq, game_id, join_date, stage_role, status,
        last_training_date, phase3_reached_at, remarks, avatar,
        is_ziye_assistant, created_at
      FROM members WHERE id = ? LIMIT 1`,
      [auth.userId]
    )

    if (!rows.length) {
      return res.status(404).json({ success: false, message: '成员不存在' })
    }

    res.json({ success: true, data: rows[0] })
  } catch (error) {
    console.error('获取个人资料失败:', error)
    res.status(500).json({ success: false, message: '获取成员信息失败' })
  }
})

// 获取所有成员列表（不含已退队归档；恢复仅走 lookup-qq）
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        id,
        nickname,
        qq,
        game_id,
        join_date,
        stage_role,
        status,
        last_training_date,
        phase3_reached_at,
        remarks,
        avatar,
        is_ziye_assistant,
        created_at
      FROM members
      WHERE status != '已退队'
      ORDER BY created_at DESC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取成员列表失败:', error)
    res.status(500).json({
      success: false,
      message: '获取成员列表失败'
    })
  }
})

// 检测达到准考标准的成员（完成前四部分）
router.get('/exam-candidates', async (req, res) => {
  try {
    // 获取所有课程，按code排序
    const [courses] = await pool.query(`
      SELECT id, code FROM courses ORDER BY code
    `)
    
    // 按课程部分分组（1.X, 2.X, 3.X, 4.X）
    const courseParts = {
      '1': courses.filter(c => c.code.startsWith('1.')),
      '2': courses.filter(c => c.code.startsWith('2.')),
      '3': courses.filter(c => c.code.startsWith('3.')),
      '4': courses.filter(c => c.code.startsWith('4.'))
    }
    
    // 获取所有新训三期的成员（不包括新训准考和特殊职位）
    const [members] = await pool.query(`
      SELECT id, nickname, qq, stage_role, join_date, avatar 
      FROM members 
      WHERE stage_role = '新训三期' AND status != '已退队'
      ORDER BY join_date DESC
    `)
    
    const qualifiedMembers = []
    
    // 检查每个成员的课程完成情况
    for (const member of members) {
      const [progress] = await pool.query(`
        SELECT course_id, progress
        FROM student_course_progress
        WHERE member_id = ?
      `, [member.id])
      
      // 检查前四部分是否全部完成
      const part1Completed = courseParts['1'].length > 0 && courseParts['1'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      const part2Completed = courseParts['2'].length > 0 && courseParts['2'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      const part3Completed = courseParts['3'].length > 0 && courseParts['3'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      const part4Completed = courseParts['4'].length > 0 && courseParts['4'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      // 如果前四部分全部完成，添加到合格列表
      if (part1Completed && part2Completed && part3Completed && part4Completed) {
        qualifiedMembers.push({
          id: member.id,
          nickname: member.nickname,
          qq: member.qq,
          stage_role: member.stage_role,
          join_date: member.join_date
        })
      }
    }
    
    res.json({
      success: true,
      data: qualifiedMembers
    })
  } catch (error) {
    console.error('检测准考标准成员失败:', error)
    res.status(500).json({
      success: false,
      message: '检测准考标准成员失败: ' + error.message
    })
  }
})

// 按 QQ 查询成员（用于添加/恢复）
router.get('/lookup-qq', async (req, res) => {
  try {
    const qq = String(req.query.qq || '').trim()
    if (!qq) {
      return res.status(400).json({
        success: false,
        message: '请提供 QQ 号'
      })
    }

    const [rows] = await pool.query(
      `SELECT id, nickname, qq, game_id, join_date, stage_role, status,
              last_training_date, phase3_reached_at, avatar
       FROM members WHERE qq = ? LIMIT 1`,
      [qq]
    )

    if (rows.length === 0) {
      return res.json({
        success: true,
        data: { exists: false }
      })
    }

    res.json({
      success: true,
      data: {
        exists: true,
        ...rows[0]
      }
    })
  } catch (error) {
    console.error('按 QQ 查询成员失败:', error)
    res.status(500).json({
      success: false,
      message: '按 QQ 查询成员失败'
    })
  }
})

// 已退队成员（紫夜数据库，隐藏入口用）
router.get('/archived', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        m.id,
        m.nickname,
        m.qq,
        m.game_id,
        m.join_date,
        m.stage_role,
        m.status,
        m.last_training_date,
        m.phase3_reached_at,
        m.remarks,
        m.avatar,
        m.created_at,
        qa.remarks AS quit_reason,
        qa.apply_date AS quit_apply_date,
        qa.status AS quit_approval_status,
        qa.approver_name AS quit_approver_name,
        qa.approval_date AS quit_approval_date,
        qa.source_admin_name AS quit_source_admin_name,
        (
          SELECT COUNT(*) FROM quit_approvals qa3 WHERE qa3.member_id = m.id
        ) AS quit_count
      FROM members m
      LEFT JOIN quit_approvals qa ON qa.id = (
        SELECT qa2.id
        FROM quit_approvals qa2
        WHERE qa2.member_id = m.id
        ORDER BY
          CASE qa2.status
            WHEN '已批准' THEN 0
            WHEN '待审批' THEN 1
            ELSE 2
          END,
          qa2.id DESC
        LIMIT 1
      )
      WHERE m.status = '已退队'
      ORDER BY COALESCE(qa.approval_date, qa.apply_date, m.created_at) DESC
    `)

    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取已退队成员失败:', error)
    res.status(500).json({
      success: false,
      message: '获取已退队成员失败'
    })
  }
})

// 已退队成员详情（紫夜数据库）
router.get('/archived/:id', async (req, res) => {
  try {
    const { id } = req.params
    const [members] = await pool.query(
      `SELECT
         id, nickname, qq, game_id, join_date, stage_role, status,
         last_training_date, phase3_reached_at, remarks, avatar, created_at
       FROM members
       WHERE id = ? AND status = '已退队'`,
      [id]
    )

    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: '档案不存在或成员未退队'
      })
    }

    const member = members[0]

    const [quitHistory] = await pool.query(
      `SELECT
         qa.id, qa.apply_date, qa.status, qa.remarks, qa.source_type,
         qa.source_admin_name, qa.source_assistant_name,
         qa.approver_name, qa.approval_date,
         COALESCE(am.nickname, qa.source_assistant_name) AS source_assistant_display
       FROM quit_approvals qa
       LEFT JOIN members am ON am.id = qa.source_assistant_id
       WHERE qa.member_id = ?
       ORDER BY qa.id DESC`,
      [id]
    )

    const [[bpCount]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM black_point_records WHERE member_id = ?`,
      [id]
    )
    const [[leaveCount]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM leave_records WHERE member_id = ?`,
      [id]
    )
    const [[assessmentCount]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM assessments WHERE member_id = ?`,
      [id]
    )

    const latestQuit = quitHistory[0] || null

    res.json({
      success: true,
      data: {
        ...member,
        quit_reason: latestQuit?.remarks || null,
        quit_apply_date: latestQuit?.apply_date || null,
        quit_approval_status: latestQuit?.status || null,
        quit_approver_name: latestQuit?.approver_name || null,
        quit_approval_date: latestQuit?.approval_date || null,
        quit_source_admin_name:
          latestQuit?.source_admin_name
          || latestQuit?.source_assistant_display
          || latestQuit?.source_assistant_name
          || null,
        quit_history: quitHistory,
        quit_count: quitHistory.length,
        stats: {
          black_points: Number(bpCount?.cnt || 0),
          leaves: Number(leaveCount?.cnt || 0),
          assessments: Number(assessmentCount?.cnt || 0),
        }
      }
    })
  } catch (error) {
    console.error('获取已退队成员详情失败:', error)
    res.status(500).json({
      success: false,
      message: '获取已退队成员详情失败'
    })
  }
})

// 获取单个成员信息
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const [rows] = await pool.query(
      'SELECT * FROM members WHERE id = ?',
      [id]
    )
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    res.json({
      success: true,
      data: rows[0]
    })
  } catch (error) {
    console.error('获取成员信息失败:', error)
    res.status(500).json({
      success: false,
      message: '获取成员信息失败'
    })
  }
})

// 添加新成员
router.post('/', async (req, res) => {
  try {
    const {
      nickname,
      qq,
      game_id,
      join_date,
      stage_role,
      status,
      last_training_date
    } = req.body
    
    // 验证必填字段
    if (!nickname || !qq) {
      return res.status(400).json({
        success: false,
        message: '昵称和QQ号为必填项'
      })
    }
    
    // 用户名使用昵称，密码默认为QQ号
    const username = nickname
    const password = qq

    const [existingQq] = await pool.query(
      `SELECT id, nickname, qq, game_id, join_date, stage_role, status,
              last_training_date, phase3_reached_at, avatar
       FROM members WHERE qq = ? LIMIT 1`,
      [qq]
    )

    if (existingQq.length > 0) {
      if (existingQq[0].status === '已退队') {
        return res.status(409).json({
          success: false,
          code: 'ARCHIVED_QQ',
          message: '该 QQ 对应已退队归档成员，请选择恢复',
          data: existingQq[0]
        })
      }
      return res.status(400).json({
        success: false,
        message: 'QQ号已存在'
      })
    }

    const [existingName] = await pool.query(
      'SELECT id FROM members WHERE username = ? OR nickname = ? LIMIT 1',
      [username, nickname]
    )

    if (existingName.length > 0) {
      return res.status(400).json({
        success: false,
        message: '昵称已存在'
      })
    }
    
    // 加密密码（使用QQ号）
    const hashedPassword = await bcrypt.hash(password, 10)
    
    // 插入数据库
    const [result] = await pool.query(`
      INSERT INTO members (
        username,
        password,
        nickname,
        qq,
        game_id,
        join_date,
        stage_role,
        status,
        last_training_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      username,
      hashedPassword,
      nickname,
      qq,
      game_id || null,
      toMySQLDate(join_date) || toMySQLDate(new Date()),
      stage_role || '未新训',
      status || '正常',
      toMySQLDate(last_training_date)
    ])

    const newId = result.insertId
    await ensurePhase3ReachedAt(pool, newId, stage_role || '未新训')
    
    res.json({
      success: true,
      message: '成员添加成功',
      data: {
        id: result.insertId
      }
    })
  } catch (error) {
    console.error('添加成员失败:', error)
    res.status(500).json({
      success: false,
      message: '添加成员失败'
    })
  }
})

// 更新成员信息
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const {
      nickname,
      qq,
      game_id,
      join_date,
      stage_role,
      status,
      last_training_date,
      remarks,
      phase3_reached_at,
    } = req.body
    
    // 检查成员是否存在
    const [existing] = await pool.query(
      'SELECT id, stage_role, last_training_date FROM members WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }

    const prevTrainingDate = toMySQLDate(existing[0].last_training_date)

    const hasPhase3Field = Object.prototype.hasOwnProperty.call(req.body, 'phase3_reached_at')
    
    // 更新数据
    if (hasPhase3Field) {
      await pool.query(`
        UPDATE members SET
          nickname = ?,
          qq = ?,
          game_id = ?,
          join_date = ?,
          stage_role = ?,
          status = ?,
          last_training_date = ?,
          remarks = ?,
          phase3_reached_at = ?
        WHERE id = ?
      `, [
        nickname,
        qq,
        game_id,
        toMySQLDate(join_date),
        stage_role,
        status,
        toMySQLDate(last_training_date),
        remarks || null,
        toMySQLDate(phase3_reached_at),
        id
      ])
    } else {
      await pool.query(`
        UPDATE members SET
          nickname = ?,
          qq = ?,
          game_id = ?,
          join_date = ?,
          stage_role = ?,
          status = ?,
          last_training_date = ?,
          remarks = ?
        WHERE id = ?
      `, [
        nickname,
        qq,
        game_id,
        toMySQLDate(join_date),
        stage_role,
        status,
        toMySQLDate(last_training_date),
        remarks || null,
        id
      ])
    }

    // 阶段升到三期及以上时自动补首次达三期日；若本次已显式提交该字段则尊重管理员设置
    if (stage_role && !hasPhase3Field) {
      await ensurePhase3ReachedAt(pool, id, stage_role)
    }

    // 设为「紫夜助教」阶段时同步开启助教身份；改为其他阶段不自动取消（可与尖兵并存）
    if (stage_role === '紫夜助教') {
      await pool.query('UPDATE members SET is_ziye_assistant = 1 WHERE id = ?', [id])
      await pool.query(
        `INSERT INTO assistant_permissions (assistant_member_id, permissions_json)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE assistant_member_id = assistant_member_id`,
        [id, JSON.stringify({
          view_training_roster: true,
          request_student: true,
          manage_assigned_progress: true,
          propose_stage_promotion: true,
          propose_member_create: true,
          propose_member_edit: true,
          propose_black_point: true,
          propose_leave: true,
          view_assigned_attendance: true,
          propose_quit: true,
          screen_share_assistant: false,
        })]
      )
    }

    // 若设置的最后新训日存在签到任务，记入该日「管理代签」
    {
      const trainDate = toMySQLDate(last_training_date)
      if (trainDate) {
        try {
          const { syncProxyCheckinFromTrainingDate } = await import('../utils/checkinService.js')
          const actor = req.admin || req.user || {}
          await syncProxyCheckinFromTrainingDate(id, trainDate, {
            type: 'admin',
            id: actor.id,
            name: actor.name || actor.username || '管理员',
            previousLastTrainingDate: prevTrainingDate,
          })
        } catch (e) {
          console.warn('[members] sync checkin proxy', e.message)
        }
      }
    }
    
    res.json({
      success: true,
      message: '成员信息更新成功'
    })
  } catch (error) {
    console.error('更新成员信息失败:', error)
    res.status(500).json({
      success: false,
      message: '更新成员信息失败'
    })
  }
})

// 彻底删除已退队归档（紫夜数据库）：抹除成员及全部关联数据
router.delete('/archived/:id/purge', async (req, res) => {
  try {
    const purged = await purgeArchivedMember(pool, req.params.id)
    res.json({
      success: true,
      message: `已彻底删除「${purged.nickname}」及其全部相关数据`,
      data: purged,
    })
  } catch (error) {
    console.error('彻底删除归档成员失败:', error)
    const status = error.status || 500
    res.status(status).json({
      success: false,
      message: error.message || '彻底删除失败',
    })
  }
})

// 恢复已退队归档成员
router.post('/:id/restore', async (req, res) => {
  try {
    const { id } = req.params
    const { join_date, nickname, stage_role } = req.body || {}

    const [existing] = await pool.query(
      'SELECT id, nickname, username, status, stage_role FROM members WHERE id = ?',
      [id]
    )

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }

    if (existing[0].status !== '已退队') {
      return res.status(400).json({
        success: false,
        message: '仅已退队归档成员可恢复'
      })
    }

    const newNickname = (nickname && String(nickname).trim()) || existing[0].nickname
    const newUsername = newNickname
    const newStageRole = (stage_role && String(stage_role).trim()) || existing[0].stage_role

    if (newNickname !== existing[0].nickname || newUsername !== existing[0].username) {
      const [conflict] = await pool.query(
        'SELECT id FROM members WHERE (username = ? OR nickname = ?) AND id != ? LIMIT 1',
        [newUsername, newNickname, id]
      )
      if (conflict.length > 0) {
        return res.status(400).json({
          success: false,
          message: '昵称已被其他成员占用'
        })
      }
    }

    await pool.query(
      `UPDATE members
       SET status = '正常',
           join_date = ?,
           phase3_reached_at = NULL,
           nickname = ?,
           username = ?,
           stage_role = ?
       WHERE id = ?`,
      [
        toMySQLDate(join_date) || toMySQLDate(new Date()),
        newNickname,
        newUsername,
        newStageRole,
        id
      ]
    )

    res.json({
      success: true,
      message: '成员已恢复'
    })
  } catch (error) {
    console.error('恢复成员失败:', error)
    res.status(500).json({
      success: false,
      message: '恢复成员失败'
    })
  }
})

// 删除成员
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    // 检查成员是否存在
    const [existing] = await pool.query(
      'SELECT id FROM members WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    // 删除成员
    await pool.query('DELETE FROM members WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '成员删除成功'
    })
  } catch (error) {
    console.error('删除成员失败:', error)
    res.status(500).json({
      success: false,
      message: '删除成员失败'
    })
  }
})

// 管理员更新学员头像
router.put('/:id/avatar', async (req, res) => {
  try {
    const { id } = req.params
    let avatar = req.body?.avatar

    const [existing] = await pool.query('SELECT id FROM members WHERE id = ?', [id])
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: '成员不存在' })
    }

    if (avatar === null || avatar === '') {
      avatar = null
    } else if (typeof avatar === 'string') {
      if (!avatar.startsWith('data:image/')) {
        return res.status(400).json({ success: false, message: '头像格式无效' })
      }
      if (avatar.length > 350_000) {
        return res.status(400).json({ success: false, message: '头像过大，请选用更小的图片' })
      }
    } else {
      return res.status(400).json({ success: false, message: '请提供头像数据' })
    }

    await pool.query('UPDATE members SET avatar = ? WHERE id = ?', [avatar, id])
    res.json({
      success: true,
      message: avatar ? '头像已更新' : '头像已清除',
      data: { avatar },
    })
  } catch (error) {
    console.error('更新成员头像失败:', error)
    res.status(500).json({ success: false, message: '更新成员头像失败' })
  }
})

// 重置单个成员密码为QQ号
router.put('/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params
    
    // 获取成员QQ号
    const [members] = await pool.query(
      'SELECT qq, nickname FROM members WHERE id = ?',
      [id]
    )
    
    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    const { qq, nickname } = members[0]
    
    // 将密码重置为QQ号
    const hashedPassword = await bcrypt.hash(qq, 10)
    
    await pool.query(
      'UPDATE members SET password = ? WHERE id = ?',
      [hashedPassword, id]
    )
    
    res.json({
      success: true,
      message: `已将 ${nickname} 的密码重置为QQ号`
    })
  } catch (error) {
    console.error('重置密码失败:', error)
    res.status(500).json({
      success: false,
      message: '重置密码失败'
    })
  }
})

// 批量重置密码为QQ号
router.put('/batch/reset-password', async (req, res) => {
  try {
    const { ids } = req.body
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请选择要重置密码的成员'
      })
    }
    
    // 批量重置
    for (const id of ids) {
      const [members] = await pool.query(
        'SELECT qq FROM members WHERE id = ?',
        [id]
      )
      
      if (members.length > 0) {
        const { qq } = members[0]
        const hashedPassword = await bcrypt.hash(qq, 10)
        
        await pool.query(
          'UPDATE members SET password = ? WHERE id = ?',
          [hashedPassword, id]
        )
      }
    }
    
    res.json({
      success: true,
      message: `已为 ${ids.length} 个成员重置密码为QQ号`
    })
  } catch (error) {
    console.error('批量重置密码失败:', error)
    res.status(500).json({
      success: false,
      message: '批量重置密码失败'
    })
  }
})

// 自动同步成员阶段
router.post('/sync-stage', async (req, res) => {
  try {
    const { memberIds } = req.body
    
    // 定义不需要自动调整阶段的特殊职位
    const specialRoles = ['新训准考', '紫夜', '紫夜尖兵', '紫夜助教', '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师']
    
    let updatedCount = 0
    let skippedCount = 0
    const updatedMemberIds = []  // 记录被更新的成员ID
    const warningMembers = []  // 记录新训准考但课程进度不足的成员
    
    // 获取所有课程，按code排序
    const [courses] = await pool.query(`
      SELECT id, code FROM courses ORDER BY code
    `)
    
    // 按课程部分分组（1.X, 2.X, 3.X, 4.X等）
    const courseParts = {
      '1': courses.filter(c => c.code.startsWith('1.')),
      '2': courses.filter(c => c.code.startsWith('2.')),
      '3': courses.filter(c => c.code.startsWith('3.')),
      '4': courses.filter(c => c.code.startsWith('4.'))
    }
    
    // 如果没有提供memberIds，则处理所有非特殊职位的成员
    let membersToProcess
    if (memberIds && memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',')
      const [members] = await pool.query(
        `SELECT id, nickname, stage_role FROM members WHERE id IN (${placeholders}) AND stage_role NOT IN (${specialRoles.map(() => '?').join(',')})`,
        [...memberIds, ...specialRoles]
      )
      membersToProcess = members
    } else {
      const [members] = await pool.query(
        `SELECT id, nickname, stage_role FROM members WHERE stage_role NOT IN (${specialRoles.map(() => '?').join(',')}) AND status != '已退队'`,
        specialRoles
      )
      membersToProcess = members
    }
    
    for (const member of membersToProcess) {
      // 获取该成员的所有课程进度
      const [progress] = await pool.query(`
        SELECT course_id, progress
        FROM student_course_progress
        WHERE member_id = ? AND progress > 0
      `, [member.id])
      
      // 如果一节课都没上过，跳过
      if (progress.length === 0) {
        skippedCount++
        continue
      }
      
      // 计算各部分完成情况
      let newStage = '未新训'
      let hasAnyProgress = false
      
      // 检查是否有任何课程进度
      for (const p of progress) {
        if (p.progress > 0) {
          hasAnyProgress = true
          break
        }
      }
      
      if (hasAnyProgress) {
        // 至少上过一节课，最低为新训初期
        newStage = '新训初期'
        
        // 检查第一部分是否全部完成
        const part1Completed = courseParts['1'].every(course => {
          const courseProgress = progress.find(p => p.course_id === course.id)
          return courseProgress && courseProgress.progress === 100
        })
        
        if (part1Completed && courseParts['1'].length > 0) {
          newStage = '新训一期'
          
          // 检查第二部分是否全部完成
          const part2Completed = courseParts['2'].every(course => {
            const courseProgress = progress.find(p => p.course_id === course.id)
            return courseProgress && courseProgress.progress === 100
          })
          
          if (part2Completed && courseParts['2'].length > 0) {
            newStage = '新训二期'
            
            // 检查第三部分是否全部完成
            const part3Completed = courseParts['3'].every(course => {
              const courseProgress = progress.find(p => p.course_id === course.id)
              return courseProgress && courseProgress.progress === 100
            })
            
            if (part3Completed && courseParts['3'].length > 0) {
              newStage = '新训三期'
            }
          }
        }
      }
      
      // 如果阶段发生变化，则更新
      if (member.stage_role !== newStage) {
        await pool.query(
          'UPDATE members SET stage_role = ? WHERE id = ?',
          [newStage, member.id]
        )
        await ensurePhase3ReachedAt(pool, member.id, newStage)
        updatedCount++
        updatedMemberIds.push(member.id)  // 记录被更新的成员ID
      } else {
        skippedCount++
      }
    }
    
    // 检查所有"新训准考"成员的课程完成情况
    let examCandidateMembers = []
    if (memberIds && memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',')
      const [members] = await pool.query(
        `SELECT id, nickname FROM members WHERE id IN (${placeholders}) AND stage_role = '新训准考'`,
        memberIds
      )
      examCandidateMembers = members
    } else {
      const [members] = await pool.query(
        `SELECT id, nickname FROM members WHERE stage_role = '新训准考' AND status != '已退队'`
      )
      examCandidateMembers = members
    }
    
    // 检查每个新训准考成员的课程完成情况
    for (const member of examCandidateMembers) {
      const [progress] = await pool.query(`
        SELECT course_id, progress
        FROM student_course_progress
        WHERE member_id = ?
      `, [member.id])
      
      // 检查前四部分是否全部完成
      const part1Completed = courseParts['1'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      const part2Completed = courseParts['2'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      const part3Completed = courseParts['3'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      const part4Completed = courseParts['4'].every(course => {
        const courseProgress = progress.find(p => p.course_id === course.id)
        return courseProgress && courseProgress.progress === 100
      })
      
      // 如果前四部分没有全部完成，记录警告
      if (!part1Completed || !part2Completed || !part3Completed || !part4Completed) {
        warningMembers.push({
          id: member.id,
          nickname: member.nickname
        })
      }
    }
    
    res.json({
      success: true,
      message: `同步完成：更新 ${updatedCount} 人，跳过 ${skippedCount} 人`,
      data: {
        updated: updatedCount,
        skipped: skippedCount,
        updatedMemberIds: updatedMemberIds,  // 返回被更新的成员ID列表
        warningMembers: warningMembers  // 返回新训准考但课程进度不足的成员
      }
    })
  } catch (error) {
    console.error('同步阶段失败:', error)
    res.status(500).json({
      success: false,
      message: '同步阶段失败: ' + error.message
    })
  }
})

export default router
