-- 请假结束审批：新增「待结束审批」状态与缓冲期起点字段
ALTER TABLE leave_records
  MODIFY COLUMN status ENUM('请假中', '待结束审批', '已结束') DEFAULT '请假中' COMMENT '状态',
  ADD COLUMN buffer_start_date DATE NULL COMMENT '结束审批通过日期（缓冲期起点）' AFTER status,
  ADD COLUMN end_approver_name VARCHAR(100) NULL COMMENT '结束审批人' AFTER buffer_start_date;
