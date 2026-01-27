# 数据库迁移说明

## 催促名单功能增强

### 执行迁移（按顺序执行）

#### 1. 添加自定义超时天数字段
在MySQL中执行：
```sql
SOURCE add-custom-timeout-to-reminders.sql;
```

或者直接执行SQL：
```sql
ALTER TABLE reminder_list 
ADD COLUMN custom_timeout_days INT NULL COMMENT '自定义超时天数（为空时使用全局设置）';
```

#### 2. 添加阶段&角色字段
在MySQL中执行：
```sql
SOURCE add-stage-role-to-reminders.sql;
```

或者直接执行SQL：
```sql
ALTER TABLE reminder_list 
ADD COLUMN stage_role VARCHAR(50) NULL COMMENT '成员阶段&角色' AFTER member_name;
```

### 功能说明

#### 自定义超时天数
- `custom_timeout_days` 字段为 `NULL` 时，使用全局超时天数设置
- `custom_timeout_days` 有值时，使用该成员的自定义超时天数
- 可以在催促名单页面为每个成员单独设置超时天数
- 支持批量修改多个成员的自定义超时天数
- 清空自定义超时天数即可恢复使用全局设置

#### 阶段&角色显示
- `stage_role` 字段存储成员的当前阶段&角色信息
- 在催促名单表格中显示，方便识别成员所在阶段
- 支持按阶段&角色排序

### 迁移日期
2026-01-27
