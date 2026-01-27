-- 创建系统配置表
CREATE TABLE IF NOT EXISTS system_settings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  setting_key VARCHAR(100) UNIQUE NOT NULL COMMENT '配置键名',
  setting_value TEXT NOT NULL COMMENT '配置值',
  description VARCHAR(255) COMMENT '配置说明',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统配置表';

-- 插入默认的催促名单超时天数配置
INSERT INTO system_settings (setting_key, setting_value, description) 
VALUES ('reminder_timeout_days', '7', '催促名单全局超时天数设置')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
