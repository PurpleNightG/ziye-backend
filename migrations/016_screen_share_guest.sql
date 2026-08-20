-- 助教可同时持有的未使用访客码上限
ALTER TABLE members
  ADD COLUMN guest_code_max INT NOT NULL DEFAULT 1 COMMENT '助教一次最多可生成的未使用访客码数量' AFTER screen_share_used;

-- 屏幕共享访客码（助教/管理发放，访客凭此发起共享）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='屏幕共享访客码';
