-- 为催促名单表添加阶段&角色字段
ALTER TABLE reminder_list 
ADD COLUMN stage_role VARCHAR(50) NULL COMMENT '成员阶段&角色' AFTER member_name;

-- 更新说明：
-- stage_role 字段用于显示成员的当前阶段&角色信息
