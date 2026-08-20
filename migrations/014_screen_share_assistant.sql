-- 屏幕共享助教：成员表扩展字段
ALTER TABLE members
  ADD COLUMN is_assistant TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否为屏幕共享助教' AFTER remarks,
  ADD COLUMN screen_share_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '助教是否允许使用声网/火山共享' AFTER is_assistant,
  ADD COLUMN screen_share_quota INT NULL COMMENT '助教声网/火山共享次数上限，NULL为不限' AFTER screen_share_enabled,
  ADD COLUMN screen_share_used INT NOT NULL DEFAULT 0 COMMENT '助教已使用声网/火山共享次数' AFTER screen_share_quota;
