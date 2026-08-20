import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

// 创建数据库连接池
// sqlpub 共享库连接数紧：单进程少占、空闲尽快释放；多开本地版/线上多实例会成倍叠加
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT) || 3,
  // 必须小于 connectionLimit，否则部分 mysql2 版本不会启动空闲清理
  maxIdle: Number(process.env.DB_POOL_MAX_IDLE) || 1,
  idleTimeout: Number(process.env.DB_POOL_IDLE_MS) || 15000,
  queueLimit: 50,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: '+08:00',  // 设置时区为中国标准时间（东八区），确保所有环境时间一致
  dateStrings: true,   // DATE/DATETIME 以字符串返回，避免 JSON 序列化时区偏移
})

// 自动创建缺失的表与字段
async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_applications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      member_id INT NOT NULL COMMENT '成员ID',
      member_name VARCHAR(100) NOT NULL COMMENT '成员昵称',
      qq VARCHAR(20) NOT NULL COMMENT 'QQ号',
      reason TEXT COMMENT '请假原因',
      start_date DATE NOT NULL COMMENT '开始日期',
      end_date DATE NOT NULL COMMENT '结束日期',
      total_days INT NOT NULL COMMENT '总天数',
      status ENUM('待审批', '已批准', '已拒绝') DEFAULT '待审批' COMMENT '审批状态',
      reviewer_id INT COMMENT '审批人ID',
      reviewer_name VARCHAR(100) COMMENT '审批人姓名',
      review_date DATE COMMENT '审批日期',
      review_remark TEXT COMMENT '审批备注',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_member (member_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  const [cols] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'leave_records'
      AND COLUMN_NAME = 'buffer_start_date'
  `)
  if (cols.length === 0) {
    await pool.query(`
      ALTER TABLE leave_records
        MODIFY COLUMN status ENUM('请假中', '待结束审批', '已结束') DEFAULT '请假中' COMMENT '状态',
        ADD COLUMN buffer_start_date DATE NULL COMMENT '结束审批通过日期（缓冲期起点）' AFTER status,
        ADD COLUMN end_approver_name VARCHAR(100) NULL COMMENT '结束审批人' AFTER buffer_start_date
    `)
    console.log('✅ leave_records 结束审批字段迁移完成')
  }

  const [assistantCol] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'members'
      AND COLUMN_NAME = 'is_assistant'
  `)
  if (assistantCol.length === 0) {
    await pool.query(`
      ALTER TABLE members
        ADD COLUMN is_assistant TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否为屏幕共享助教' AFTER remarks,
        ADD COLUMN screen_share_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '助教是否允许使用声网/火山共享' AFTER is_assistant,
        ADD COLUMN screen_share_quota INT NULL COMMENT '助教声网/火山共享次数上限，NULL为不限' AFTER screen_share_enabled,
        ADD COLUMN screen_share_used INT NOT NULL DEFAULT 0 COMMENT '助教已使用声网/火山共享次数' AFTER screen_share_quota
    `)
    console.log('✅ members 屏幕共享助教字段迁移完成')
  }

  const [assessmentIdCol] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'public_videos'
      AND COLUMN_NAME = 'assessment_id'
  `)
  if (assessmentIdCol.length === 0) {
    await pool.query(`
      ALTER TABLE public_videos
        ADD COLUMN assessment_id INT NULL COMMENT '关联考核报告ID' AFTER created_by
    `)
    await pool.query(`
      ALTER TABLE public_videos
        ADD UNIQUE INDEX idx_public_videos_assessment_id (assessment_id)
    `)
    await pool.query(`
      ALTER TABLE public_videos
        ADD CONSTRAINT fk_public_videos_assessment
        FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE SET NULL
    `)
    console.log('✅ public_videos assessment_id 字段迁移完成')
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS surveys (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(200) NOT NULL COMMENT '标题',
      description TEXT NULL COMMENT '说明',
      fields_json JSON NOT NULL COMMENT '题目定义',
      is_anonymous TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否匿名',
      start_at DATETIME NULL COMMENT '开始时间',
      end_at DATETIME NULL COMMENT '结束时间',
      max_responses INT NULL COMMENT '填写人数上限，NULL为不限制',
      status ENUM('draft','published','closed') NOT NULL DEFAULT 'draft' COMMENT '状态',
      audience_roles_json JSON NULL COMMENT '可填阶段角色，空=全体',
      created_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_survey_status (status),
      INDEX idx_survey_time (start_at, end_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='填表/调查问卷'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_claims (
      id INT PRIMARY KEY AUTO_INCREMENT,
      survey_id INT NOT NULL,
      member_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME NULL,
      UNIQUE KEY uk_survey_member (survey_id, member_id),
      UNIQUE KEY uk_token_hash (token_hash),
      INDEX idx_survey_claim (survey_id),
      CONSTRAINT fk_survey_claims_survey FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='匿名填表领取凭证'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_responses (
      id INT PRIMARY KEY AUTO_INCREMENT,
      survey_id INT NOT NULL,
      answers_json JSON NOT NULL,
      member_id INT NULL COMMENT '实名时填写，匿名必须为空',
      token_hash VARCHAR(64) NULL COMMENT '匿名防重复，管理端不展示',
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_survey_resp (survey_id),
      UNIQUE KEY uk_survey_member_resp (survey_id, member_id),
      UNIQUE KEY uk_survey_token_resp (survey_id, token_hash),
      CONSTRAINT fk_survey_responses_survey FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='填表答卷'
  `)

  try {
    await pool.query(`
      ALTER TABLE surveys
      ADD COLUMN subjects_json JSON NULL COMMENT '满意度评价对象（教官等）' AFTER fields_json
    `)
    console.log('✅ surveys.subjects_json 字段迁移完成')
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }

  try {
    await pool.query(`
      ALTER TABLE surveys
      ADD COLUMN max_responses INT NULL COMMENT '填写人数上限，NULL为不限制' AFTER end_at
    `)
    console.log('✅ surveys.max_responses 字段迁移完成')
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }

  try {
    await pool.query(`
      ALTER TABLE surveys
      ADD COLUMN results_public TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否允许学员公开查看结果' AFTER max_responses
    `)
    console.log('✅ surveys.results_public 字段迁移完成')
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }

  console.log('✅ surveys 相关表迁移完成')

  const [phase3Col] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'members'
      AND COLUMN_NAME = 'phase3_reached_at'
  `)
  if (phase3Col.length === 0) {
    await pool.query(`
      ALTER TABLE members
        ADD COLUMN phase3_reached_at DATE NULL COMMENT '首次达到新训三期的日期（下调不清除）' AFTER last_training_date
    `)
    // 回填：当前已达三期及以上的成员，用加入日作为保守起点
    await pool.query(`
      UPDATE members
      SET phase3_reached_at = join_date
      WHERE phase3_reached_at IS NULL
        AND join_date IS NOT NULL
        AND stage_role IN (
          '新训三期', '新训准考', '紫夜', '紫夜尖兵',
          '会长', '执行官', '人事', '总教', '尖兵教官', '教官', '工程师'
        )
    `)
    console.log('✅ members.phase3_reached_at 字段迁移完成')
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_reminder_ignores (
      member_id INT NOT NULL PRIMARY KEY COMMENT '成员ID',
      ignored_by VARCHAR(100) NULL COMMENT '操作人',
      ignored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '忽略时间',
      CONSTRAINT fk_attendance_ignore_member
        FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='考勤催促忽略名单'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_sessions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_type ENUM('admin','student') NOT NULL,
      user_id INT NOT NULL,
      session_id CHAR(36) NOT NULL,
      device_name VARCHAR(160) NULL,
      user_agent VARCHAR(512) NULL,
      ip VARCHAR(45) NULL,
      remember_me TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=记住登录7天 0=临时会话',
      last_active_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      UNIQUE KEY uk_session_id (session_id),
      INDEX idx_ls_user (user_type, user_id),
      INDEX idx_ls_active (user_type, user_id, revoked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='登录设备会话'
  `)

  {
    const [rememberCol] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'login_sessions'
        AND COLUMN_NAME = 'remember_me'
    `)
    if (rememberCol.length === 0) {
      await pool.query(`
        ALTER TABLE login_sessions
          ADD COLUMN remember_me TINYINT(1) NOT NULL DEFAULT 1
            COMMENT '1=记住登录7天 0=临时会话'
            AFTER ip
      `)
      console.log('✅ login_sessions.remember_me 字段迁移完成')
    }
  }

  for (const table of ['members', 'admins']) {
    const [avatarCol] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = 'avatar'
    `, [table])
    if (avatarCol.length === 0) {
      await pool.query(`
        ALTER TABLE ${table}
          ADD COLUMN avatar MEDIUMTEXT NULL COMMENT '头像 data URL' AFTER password
      `)
      console.log(`✅ ${table}.avatar 字段迁移完成`)
    }
  }
  console.log('✅ login_sessions / avatar 迁移完成')

  // 屏幕共享访客码
  const [guestMaxCol] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'members'
      AND COLUMN_NAME = 'guest_code_max'
  `)
  if (guestMaxCol.length === 0) {
    await pool.query(`
      ALTER TABLE members
        ADD COLUMN guest_code_max INT NOT NULL DEFAULT 1
          COMMENT '助教一次最多可生成的未使用访客码数量'
          AFTER screen_share_used
    `)
    console.log('✅ members.guest_code_max 字段迁移完成')
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS screen_share_guest_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(16) NOT NULL,
      mode ENUM('peerjs', 'agora', 'volc') NOT NULL DEFAULT 'peerjs',
      created_by_type ENUM('admin', 'assistant') NOT NULL,
      created_by_member_id INT NULL,
      created_by_name VARCHAR(128) NOT NULL,
      status ENUM('active', 'used', 'revoked') NOT NULL DEFAULT 'active',
      used_by_nickname VARCHAR(128) NULL,
      used_at TIMESTAMP NULL,
      room_id VARCHAR(16) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_guest_code (code),
      INDEX idx_guest_status (status),
      INDEX idx_guest_creator (created_by_member_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='屏幕共享访客码'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meeting_rooms (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(8) NOT NULL,
      title VARCHAR(128) NOT NULL DEFAULT '紫夜会议',
      created_by VARCHAR(128) NOT NULL,
      status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP NULL,
      UNIQUE KEY uk_meeting_code (code),
      INDEX idx_meeting_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多人会议房间'
  `)

  // 紫夜助教：stage_role ENUM + 业务表
  try {
    await pool.query(`
      ALTER TABLE members
        MODIFY COLUMN stage_role ENUM(
          '未新训','新训初期','新训一期','新训二期','新训三期','新训准考',
          '紫夜','紫夜尖兵','紫夜助教',
          '会长','执行官','人事','总教','尖兵教官','教官','工程师'
        ) DEFAULT '未新训' COMMENT '阶段&角色'
    `)
  } catch (e) {
    console.warn('members.stage_role ENUM 迁移跳过/失败:', e.message)
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_student_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      assistant_member_id INT NOT NULL,
      student_member_id INT NOT NULL,
      status ENUM('待审批','已通过','已拒绝','已解除') NOT NULL DEFAULT '待审批',
      requested_by_type ENUM('admin','assistant') NOT NULL DEFAULT 'admin',
      requested_by_id INT NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at DATETIME NULL,
      remarks TEXT NULL,
      hidden_from_approval TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理端审批中心隐藏（已通过认领删除记录用，不解除归属）',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_asst_student (assistant_member_id, student_member_id),
      INDEX idx_asst_status (assistant_member_id, status),
      INDEX idx_student_status (student_member_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教-学员归属'
  `)

  try {
    const [asaCols] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assistant_student_assignments'
        AND COLUMN_NAME = 'hidden_from_approval'
    `)
    if (asaCols.length === 0) {
      await pool.query(`
        ALTER TABLE assistant_student_assignments
        ADD COLUMN hidden_from_approval TINYINT(1) NOT NULL DEFAULT 0
          COMMENT '管理端审批中心隐藏（已通过认领删除记录用，不解除归属）'
          AFTER remarks
      `)
    }
  } catch (e) {
    console.warn('assistant_student_assignments.hidden_from_approval 迁移跳过/失败:', e.message)
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_member_creates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      assistant_member_id INT NOT NULL,
      nickname VARCHAR(100) NOT NULL,
      qq VARCHAR(20) NOT NULL,
      game_id VARCHAR(100) NULL,
      join_date DATE NULL,
      stage_role VARCHAR(50) NOT NULL DEFAULT '未新训',
      status ENUM('待审批','已通过','已驳回') NOT NULL DEFAULT '待审批',
      reject_reason TEXT NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at DATETIME NULL,
      created_member_id INT NULL,
      restore_member_id INT NULL COMMENT '若为恢复已退队成员则为原成员ID',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_pmc_status (status),
      INDEX idx_pmc_asst (assistant_member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教添加成员待审批'
  `)

  const [pmcRestoreCol] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pending_member_creates'
      AND COLUMN_NAME = 'restore_member_id'
  `)
  if (pmcRestoreCol.length === 0) {
    await pool.query(`
      ALTER TABLE pending_member_creates
        ADD COLUMN restore_member_id INT NULL COMMENT '若为恢复已退队成员则为原成员ID' AFTER created_member_id
    `)
    console.log('✅ pending_member_creates.restore_member_id 迁移完成')
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_stage_promotions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      assistant_member_id INT NOT NULL,
      student_member_id INT NOT NULL,
      from_stage VARCHAR(50) NOT NULL,
      to_stage VARCHAR(50) NOT NULL,
      status ENUM('待审批','已通过','已驳回') NOT NULL DEFAULT '待审批',
      reason TEXT NULL,
      reject_reason TEXT NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_psp_status (status),
      INDEX idx_psp_asst (assistant_member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教升阶待审批'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_permissions (
      assistant_member_id INT PRIMARY KEY,
      permissions_json JSON NOT NULL,
      updated_by_admin_id INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教权限配置'
  `)

  const [quitAsstCol] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'quit_approvals'
      AND COLUMN_NAME = 'source_assistant_id'
  `)
  if (quitAsstCol.length === 0) {
    await pool.query(`
      ALTER TABLE quit_approvals
        ADD COLUMN source_assistant_id INT NULL COMMENT '发起退队的助教成员ID' AFTER source_admin_name,
        ADD COLUMN source_assistant_name VARCHAR(100) NULL COMMENT '发起退队的助教昵称' AFTER source_assistant_id
    `)
    console.log('✅ quit_approvals 助教来源字段迁移完成')
  }

  try {
    await pool.query(`
      ALTER TABLE quit_approvals
        MODIFY COLUMN source_type ENUM('手动', '自动', '助教') DEFAULT '手动' COMMENT '退队来源'
    `)
  } catch (e) {
    console.warn('quit_approvals.source_type ENUM 迁移跳过/失败:', e.message)
  }

  console.log('✅ 紫夜助教相关表迁移完成')

  // 助教身份与 stage_role 解耦：可同时为紫夜尖兵等阶段 + 助教
  const [ziyeAsstCol] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'members'
      AND COLUMN_NAME = 'is_ziye_assistant'
  `)
  if (ziyeAsstCol.length === 0) {
    await pool.query(`
      ALTER TABLE members
        ADD COLUMN is_ziye_assistant TINYINT(1) NOT NULL DEFAULT 0
          COMMENT '是否为紫夜助教（与 stage_role 独立，可与尖兵等并存）'
          AFTER is_assistant
    `)
    await pool.query(`UPDATE members SET is_ziye_assistant = 1 WHERE stage_role = '紫夜助教'`)
    console.log('✅ members.is_ziye_assistant 迁移完成')
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_member_edits (
      id INT AUTO_INCREMENT PRIMARY KEY,
      assistant_member_id INT NOT NULL,
      student_member_id INT NOT NULL,
      changes_json JSON NOT NULL COMMENT '拟修改字段',
      status ENUM('待审批','已通过','已驳回') NOT NULL DEFAULT '待审批',
      reject_reason TEXT NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_pme_status (status),
      INDEX idx_pme_asst (assistant_member_id),
      INDEX idx_pme_student (student_member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教修改学员信息待审批'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_black_points (
      id INT AUTO_INCREMENT PRIMARY KEY,
      assistant_member_id INT NOT NULL,
      student_member_id INT NOT NULL,
      reason TEXT NOT NULL,
      register_date DATE NOT NULL,
      status ENUM('待审批','已通过','已驳回') NOT NULL DEFAULT '待审批',
      reject_reason TEXT NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at DATETIME NULL,
      created_black_point_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_pbp_status (status),
      INDEX idx_pbp_asst (assistant_member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教登记黑点待审批'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_leaves (
      id INT AUTO_INCREMENT PRIMARY KEY,
      assistant_member_id INT NOT NULL,
      student_member_id INT NOT NULL,
      reason TEXT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status ENUM('待审批','已通过','已驳回') NOT NULL DEFAULT '待审批',
      reject_reason TEXT NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at DATETIME NULL,
      created_leave_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_pl_status (status),
      INDEX idx_pl_asst (assistant_member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教登记请假待审批'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_daily_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      assistant_member_id INT NOT NULL,
      student_member_id INT NOT NULL,
      assign_date DATE NOT NULL COMMENT '有效日（按上海日历日，过零点失效）',
      assigned_by_admin_id INT NULL,
      remarks TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_daily_asst_student_date (assistant_member_id, student_member_id, assign_date),
      INDEX idx_daily_asst_date (assistant_member_id, assign_date),
      INDEX idx_daily_student_date (student_member_id, assign_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='助教当日临时学员'
  `)

  // 课程类别 / 难度配置（独立于 courses 行，空类别也可持久化）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS course_meta_options (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kind ENUM('category', 'difficulty') NOT NULL COMMENT '类别或难度',
      name VARCHAR(100) NOT NULL COMMENT '显示名称',
      color VARCHAR(32) NOT NULL DEFAULT 'purple' COMMENT '标签颜色token',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_kind_name (kind, name),
      INDEX idx_kind_order (kind, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='课程类别与难度配置'
  `)

  try {
    await pool.query(`
      ALTER TABLE course_meta_options
      ADD COLUMN color VARCHAR(32) NOT NULL DEFAULT 'purple' COMMENT '标签颜色token' AFTER name
    `)
    console.log('✅ course_meta_options.color 字段迁移完成')
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }

  const [[catCount]] = await pool.query(
    `SELECT COUNT(*) AS c FROM course_meta_options WHERE kind = 'category'`
  )
  if (!Number(catCount?.c)) {
    const defaultCategories = [
      '入门课程',
      '标准技能一阶课程',
      '标准技能二阶课程',
      '团队训练',
      '进阶课程',
    ]
    for (let i = 0; i < defaultCategories.length; i++) {
      const colors = ['purple', 'blue', 'cyan', 'yellow', 'orange']
      await pool.query(
        `INSERT IGNORE INTO course_meta_options (kind, name, color, sort_order) VALUES ('category', ?, ?, ?)`,
        [defaultCategories[i], colors[i] || 'purple', i]
      )
    }
    // 把课程表里已有、但不在默认列表中的类别也写入
    try {
      const [usedCats] = await pool.query(
        `SELECT DISTINCT category AS name FROM courses WHERE category IS NOT NULL AND category != ''`
      )
      let order = defaultCategories.length
      const palette = ['purple', 'blue', 'cyan', 'yellow', 'orange', 'green', 'red', 'pink', 'gray']
      for (const row of usedCats) {
        if (!defaultCategories.includes(row.name)) {
          await pool.query(
            `INSERT IGNORE INTO course_meta_options (kind, name, color, sort_order) VALUES ('category', ?, ?, ?)`,
            [row.name, palette[order % palette.length], order++]
          )
        }
      }
    } catch (e) {
      // courses 表可能尚未创建，忽略
    }
    console.log('✅ course_meta_options 类别默认值已初始化')
  }

  const [[diffCount]] = await pool.query(
    `SELECT COUNT(*) AS c FROM course_meta_options WHERE kind = 'difficulty'`
  )
  if (!Number(diffCount?.c)) {
    const defaultDifficulties = [
      { name: '初级', color: 'green' },
      { name: '中级', color: 'blue' },
      { name: '高级', color: 'red' },
    ]
    for (let i = 0; i < defaultDifficulties.length; i++) {
      await pool.query(
        `INSERT IGNORE INTO course_meta_options (kind, name, color, sort_order) VALUES ('difficulty', ?, ?, ?)`,
        [defaultDifficulties[i].name, defaultDifficulties[i].color, i]
      )
    }
    try {
      const [usedDiffs] = await pool.query(
        `SELECT DISTINCT difficulty AS name FROM courses WHERE difficulty IS NOT NULL AND difficulty != ''`
      )
      let order = defaultDifficulties.length
      const palette = ['purple', 'blue', 'cyan', 'yellow', 'orange', 'green', 'red', 'pink', 'gray']
      for (const row of usedDiffs) {
        if (!defaultDifficulties.some((d) => d.name === row.name)) {
          await pool.query(
            `INSERT IGNORE INTO course_meta_options (kind, name, color, sort_order) VALUES ('difficulty', ?, ?, ?)`,
            [row.name, palette[order % palette.length], order++]
          )
        }
      }
    } catch (e) {
      // courses 表可能尚未创建，忽略
    }
    console.log('✅ course_meta_options 难度默认值已初始化')
  }

  try {
    const { ensureCheckinTables } = await import('../utils/checkinService.js')
    await ensureCheckinTables()
    console.log('✅ 学员签到相关表就绪')
  } catch (e) {
    console.warn('签到表迁移跳过/失败:', e.message)
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbooks (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(200) NOT NULL,
      description TEXT NULL,
      access_mode ENUM('shared', 'student_readonly', 'assigned') NOT NULL DEFAULT 'student_readonly'
        COMMENT 'shared=全员可改; student_readonly=学员只读; assigned=指定学员可填',
      status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
      content_json LONGTEXT NOT NULL,
      created_by VARCHAR(100) NULL,
      updated_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workbook_status (status),
      INDEX idx_workbook_mode (access_mode)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='在线表格文档'
  `)
  try {
    await pool.query(`
      ALTER TABLE workbooks
      MODIFY COLUMN access_mode ENUM('shared', 'student_readonly', 'assigned') NOT NULL DEFAULT 'student_readonly'
        COMMENT 'shared=全员可改; student_readonly=学员只读; assigned=指定学员可填'
    `)
  } catch (e) {
    /* 已是新枚举 */
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbook_revisions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      workbook_id INT NOT NULL,
      content_json LONGTEXT NOT NULL COMMENT '该次编辑之前的表格快照',
      edited_by VARCHAR(100) NULL COMMENT '本次编辑者（回退即回到此人改之前）',
      edited_by_type ENUM('admin', 'student') NOT NULL DEFAULT 'admin',
      edited_by_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wb_rev_workbook (workbook_id, id DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='表格编辑历史（存编辑前状态）'
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbook_assignees (
      workbook_id INT NOT NULL,
      member_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workbook_id, member_id),
      INDEX idx_wb_assignee_member (member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='指定可填写学员'
  `)
}

// 测试数据库连接
async function testConnection() {
  try {
    const connection = await pool.getConnection()
    console.log('✅ 数据库连接成功!')
    console.log(`📊 数据库: ${process.env.DB_NAME}`)
    console.log(`🔗 主机: ${process.env.DB_HOST}:${process.env.DB_PORT}`)
    connection.release()
    await runMigrations()
    return true
  } catch (error) {
    console.error('❌ 数据库连接失败:', error.message)
    return false
  }
}

export { pool, testConnection }

/** 进程退出时释放连接池，避免 sqlpub 上残留 Sleep */
export async function closePool() {
  try {
    await pool.end()
  } catch (e) {
    console.warn('[db] pool.end:', e?.message || e)
  }
}
