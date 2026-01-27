-- 为 members 表添加 remarks 字段
ALTER TABLE members ADD COLUMN remarks TEXT COMMENT '备注信息' AFTER last_training_date;

-- 验证字段已添加
DESCRIBE members;
