-- 创建考核记录表
CREATE TABLE IF NOT EXISTS assessments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL COMMENT '学员ID',
  member_name VARCHAR(100) NOT NULL COMMENT '学员姓名',
  assessment_date DATE NOT NULL COMMENT '考核日期',
  status ENUM('待处理', '已通过', '未通过', '未完成') DEFAULT '待处理' COMMENT '考核结果',
  map VARCHAR(50) NOT NULL COMMENT '地图名称',
  custom_map VARCHAR(100) DEFAULT NULL COMMENT '自定义地图名称',
  evaluation TEXT DEFAULT NULL COMMENT '评价',
  deduction_records JSON DEFAULT NULL COMMENT '扣分记录（JSON格式）',
  total_score DECIMAL(5,2) DEFAULT 100.00 COMMENT '总分（满分100）',
  rating VARCHAR(20) DEFAULT NULL COMMENT '评级（合格/良好/优秀/完美）',
  has_evaluation BOOLEAN DEFAULT FALSE COMMENT '是否已填写评价',
  has_deduction_records BOOLEAN DEFAULT FALSE COMMENT '是否已填写考核记录',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='考核记录表';

-- 创建索引
CREATE INDEX idx_member_id ON assessments(member_id);
CREATE INDEX idx_assessment_date ON assessments(assessment_date);
CREATE INDEX idx_status ON assessments(status);
CREATE INDEX idx_created_at ON assessments(created_at);
