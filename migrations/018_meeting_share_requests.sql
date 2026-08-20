-- 会议内学员申请屏幕共享（需管理员同意）
CREATE TABLE IF NOT EXISTS meeting_share_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  username VARCHAR(128) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  UNIQUE KEY uk_meeting_share_session (code, session_id),
  INDEX idx_meeting_share_status (code, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会议内共享申请';
