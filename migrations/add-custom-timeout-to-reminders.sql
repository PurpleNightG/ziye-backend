-- 为催促名单表添加自定义超时天数字段
ALTER TABLE reminder_list 
ADD COLUMN custom_timeout_days INT NULL COMMENT '自定义超时天数（为空时使用全局设置）';

-- 更新说明：
-- custom_timeout_days 为 NULL 时，使用全局超时天数设置
-- custom_timeout_days 有值时，使用该成员的自定义超时天数
