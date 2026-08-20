-- 创建学员请假申请表
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
  reviewer_id INT COMMENT '审批人ID（管理员）',
  reviewer_name VARCHAR(100) COMMENT '审批人姓名',
  review_date DATE COMMENT '审批日期',
  review_remark TEXT COMMENT '审批备注',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_member (member_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
