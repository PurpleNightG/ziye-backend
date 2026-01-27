-- 创建公开视频表
CREATE TABLE IF NOT EXISTS public_videos (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL COMMENT '视频标题',
  participant_a VARCHAR(100) NOT NULL COMMENT '参与者A',
  participant_b VARCHAR(100) NOT NULL COMMENT '参与者B',
  assessment_date DATE NOT NULL COMMENT '考核日期',
  video_url TEXT NOT NULL COMMENT '视频链接',
  description TEXT COMMENT '视频描述',
  created_by INT NOT NULL COMMENT '创建者ID',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='公开视频表';

-- 创建索引
CREATE INDEX idx_assessment_date ON public_videos(assessment_date);
CREATE INDEX idx_created_by ON public_videos(created_by);
CREATE INDEX idx_created_at ON public_videos(created_at);
