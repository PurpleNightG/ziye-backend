-- 紫夜公会管理系统数据库初始化脚本

-- 创建管理员表
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  email VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 创建成员表（原学员表升级）
CREATE TABLE IF NOT EXISTS members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  nickname VARCHAR(100) NOT NULL COMMENT '昵称',
  qq VARCHAR(20) NOT NULL COMMENT 'QQ号',
  game_id VARCHAR(100) COMMENT '游戏ID',
  email VARCHAR(100),
  join_date DATE COMMENT '加入时间',
  stage_role ENUM(
    '未新训',
    '新训初期',
    '新训一期',
    '新训二期',
    '新训三期',
    '新训准考',
    '紫夜',
    '紫夜尖兵',
    '会长',
    '执行官',
    '人事',
    '总教',
    '尖兵教官',
    '教官',
    '工程师'
  ) DEFAULT '未新训' COMMENT '阶段&角色',
  status ENUM('正常', '请假中', '已退队', '其他') DEFAULT '正常' COMMENT '状态',
  last_training_date DATE COMMENT '最后新训日期',
  remarks TEXT COMMENT '备注信息',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_username (username),
  INDEX idx_qq (qq),
  INDEX idx_stage_role (stage_role),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 插入默认管理员账号（密码: admin123）
INSERT INTO admins (username, password, name, email) 
VALUES ('admin', '$2a$10$InLAnAVhnzthqxAf9JN8KuB3rS3X6NcFUkM6UhpPU9nsZZB2IxXvy', '系统管理员', 'admin@ziye.com')
ON DUPLICATE KEY UPDATE password='$2a$10$InLAnAVhnzthqxAf9JN8KuB3rS3X6NcFUkM6UhpPU9nsZZB2IxXvy';

-- 插入测试成员账号（密码: member123）
INSERT INTO members (username, password, nickname, qq, game_id, join_date, stage_role, status, last_training_date) 
VALUES ('member', '$2a$10$xksZfbbawytisfjk74wwmO6ONH9v8m68WD.P2iuBxdmkka5kw/MZy', '测试成员', '123456789', 'TestPlayer', '2024-01-01', '新训一期', '正常', '2024-01-15')
ON DUPLICATE KEY UPDATE password='$2a$10$xksZfbbawytisfjk74wwmO6ONH9v8m68WD.P2iuBxdmkka5kw/MZy';

-- 创建请假记录表
CREATE TABLE IF NOT EXISTS leave_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '成员ID',
  member_name VARCHAR(100) NOT NULL COMMENT '成员昵称',
  qq VARCHAR(20) NOT NULL COMMENT 'QQ号',
  reason TEXT COMMENT '请假原因',
  start_date DATE NOT NULL COMMENT '开始日期',
  end_date DATE NOT NULL COMMENT '结束日期',
  total_days INT NOT NULL COMMENT '总天数',
  status ENUM('请假中', '已结束') DEFAULT '请假中' COMMENT '状态',
  created_by INT COMMENT '创建人（管理员ID）',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_member (member_id),
  INDEX idx_status (status),
  INDEX idx_dates (start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 创建黑点记录表
CREATE TABLE IF NOT EXISTS black_point_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '成员ID',
  member_name VARCHAR(100) NOT NULL COMMENT '成员昵称',
  qq VARCHAR(20) NOT NULL COMMENT 'QQ号',
  reason TEXT NOT NULL COMMENT '黑点原因',
  register_date DATE NOT NULL COMMENT '登记日期',
  recorder_id INT NOT NULL COMMENT '记录人（管理员ID）',
  recorder_name VARCHAR(100) NOT NULL COMMENT '记录人姓名',
  status ENUM('生效中', '已失效') DEFAULT '生效中' COMMENT '状态',
  invalid_date DATE COMMENT '失效日期',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (recorder_id) REFERENCES admins(id) ON DELETE CASCADE,
  INDEX idx_member (member_id),
  INDEX idx_status (status),
  INDEX idx_register_date (register_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 创建催促名单表
CREATE TABLE IF NOT EXISTS reminder_list (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '成员ID',
  member_name VARCHAR(100) NOT NULL COMMENT '成员昵称',
  last_training_date DATE COMMENT '最后新训日期',
  days_without_training INT NOT NULL COMMENT '未训天数',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  UNIQUE KEY unique_member (member_id),
  INDEX idx_days (days_without_training)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 创建退队审批表
CREATE TABLE IF NOT EXISTS quit_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '成员ID',
  member_name VARCHAR(100) NOT NULL COMMENT '成员昵称',
  qq VARCHAR(20) NOT NULL COMMENT 'QQ号',
  apply_date DATE NOT NULL COMMENT '申请日期',
  source_type ENUM('手动', '自动') DEFAULT '手动' COMMENT '退队来源',
  source_admin_id INT COMMENT '来源管理员ID（手动时）',
  source_admin_name VARCHAR(100) COMMENT '来源管理员姓名（手动时）',
  status ENUM('待审批', '已批准', '已拒绝') DEFAULT '待审批' COMMENT '审批状态',
  approver_id INT COMMENT '审批人ID',
  approver_name VARCHAR(100) COMMENT '审批人姓名',
  approval_date DATE COMMENT '审批日期',
  remarks TEXT COMMENT '备注',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (source_admin_id) REFERENCES admins(id) ON DELETE SET NULL,
  FOREIGN KEY (approver_id) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_member (member_id),
  INDEX idx_status (status),
  INDEX idx_apply_date (apply_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 创建留队管理表
CREATE TABLE IF NOT EXISTS retention_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '成员ID',
  member_name VARCHAR(100) NOT NULL COMMENT '成员昵称',
  qq VARCHAR(20) NOT NULL COMMENT 'QQ号',
  stage_role VARCHAR(50) NOT NULL COMMENT '阶段&角色',
  last_training_date DATE COMMENT '最后新训日期',
  retention_reason TEXT NOT NULL COMMENT '留队原因',
  approver_remarks TEXT COMMENT '批准者备注',
  approver_id INT NOT NULL COMMENT '批准者ID',
  approver_name VARCHAR(100) NOT NULL COMMENT '批准者姓名',
  approval_date DATE NOT NULL COMMENT '批准日期',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (approver_id) REFERENCES admins(id) ON DELETE CASCADE,
  INDEX idx_member (member_id),
  INDEX idx_approval_date (approval_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
