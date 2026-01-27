-- 创建考核申请表
CREATE TABLE IF NOT EXISTS assessment_applications (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL COMMENT '学员ID',
  member_name VARCHAR(100) NOT NULL COMMENT '学员姓名',
  companion VARCHAR(100) NOT NULL COMMENT '陪考人员',
  preferred_date DATE NOT NULL COMMENT '期望考核日期',
  preferred_time VARCHAR(50) NOT NULL COMMENT '期望考核时间',
  status ENUM('待审批', '已通过', '已驳回') DEFAULT '待审批' COMMENT '审批状态',
  admission_ticket VARCHAR(50) DEFAULT NULL COMMENT '准考证号',
  reject_reason TEXT DEFAULT NULL COMMENT '驳回理由',
  approved_by VARCHAR(100) DEFAULT NULL COMMENT '审批人',
  approved_at TIMESTAMP NULL DEFAULT NULL COMMENT '审批时间',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '申请时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='考核申请表';

-- 创建索引
CREATE INDEX idx_member_id ON assessment_applications(member_id);
CREATE INDEX idx_status ON assessment_applications(status);
CREATE INDEX idx_preferred_date ON assessment_applications(preferred_date);
CREATE INDEX idx_created_at ON assessment_applications(created_at);
