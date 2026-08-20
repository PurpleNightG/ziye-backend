-- 为 assessments 表的 status 字段添加"模拟考"选项

-- 如果 status 字段是 ENUM 类型，需要修改 ENUM
ALTER TABLE assessments 
MODIFY COLUMN status ENUM('待处理', '已通过', '未通过', '未完成', '模拟考') NOT NULL DEFAULT '待处理';

-- 如果您的数据库中 status 是 VARCHAR 类型，则不需要执行此迁移
-- 可以直接使用新的"模拟考"状态
