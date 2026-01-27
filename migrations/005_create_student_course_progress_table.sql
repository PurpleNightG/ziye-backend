-- 创建学员课程进度表
CREATE TABLE IF NOT EXISTS student_course_progress (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '成员ID',
  course_id INT NOT NULL COMMENT '课程ID',
  progress INT NOT NULL DEFAULT 0 COMMENT '进度（0, 10, 20, 50, 75, 100）',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_member_course (member_id, course_id),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  INDEX idx_member_id (member_id),
  INDEX idx_course_id (course_id),
  INDEX idx_progress (progress)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学员课程进度表';
