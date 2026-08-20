-- 屏幕共享邀请（持久化，解决多实例内存丢失）
CREATE TABLE IF NOT EXISTS room_invites (
  member_id INT NOT NULL PRIMARY KEY,
  room_id VARCHAR(16) NOT NULL,
  invited_by VARCHAR(128) NOT NULL,
  invited_at BIGINT NOT NULL,
  INDEX idx_room_invites_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='屏幕共享待处理邀请';

-- 会议邀请
CREATE TABLE IF NOT EXISTS meeting_invites (
  member_id INT NOT NULL PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  title VARCHAR(256) NOT NULL DEFAULT '',
  invited_by VARCHAR(128) NOT NULL,
  invited_at BIGINT NOT NULL,
  INDEX idx_meeting_invites_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会议待处理邀请';

-- 屏幕共享进入申请
CREATE TABLE IF NOT EXISTS room_join_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_id VARCHAR(16) NOT NULL,
  member_id INT NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_room_join_member (room_id, member_id),
  INDEX idx_room_join_status (room_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='屏幕共享进入申请';

-- 会议进入申请
CREATE TABLE IF NOT EXISTS meeting_join_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  member_id INT NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_meeting_join_member (code, member_id),
  INDEX idx_meeting_join_status (code, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会议进入申请';
