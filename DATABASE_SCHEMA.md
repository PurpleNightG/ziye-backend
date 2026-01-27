# 紫夜公会管理系统数据库表结构说明

## 数据库概览

本系统使用 MySQL 数据库，包含以下核心表：

1. `admins` - 管理员表
2. `members` - 成员表
3. `leave_records` - 请假记录表
4. `black_point_records` - 黑点记录表
5. `reminder_list` - 催促名单表
6. `quit_approvals` - 退队审批表
7. `retention_records` - 留队管理表

---

## 表结构详细说明

### 1. 管理员表 (admins)

管理员账号信息表

| 字段 | 类型 | 说明 | 备注 |
|------|------|------|------|
| id | INT | 主键ID | 自增 |
| username | VARCHAR(50) | 用户名 | 唯一，登录用 |
| password | VARCHAR(255) | 密码 | BCrypt加密 |
| name | VARCHAR(100) | 姓名 | |
| email | VARCHAR(100) | 邮箱 | |
| created_at | TIMESTAMP | 创建时间 | 自动 |
| updated_at | TIMESTAMP | 更新时间 | 自动 |

**索引**：
- `idx_username` - 用户名索引

---

### 2. 成员表 (members)

公会成员信息表

| 字段 | 类型 | 说明 | 备注 |
|------|------|------|------|
| id | INT | 主键ID | 自增 |
| username | VARCHAR(50) | 用户名 | 唯一，登录用 |
| password | VARCHAR(255) | 密码 | BCrypt加密 |
| nickname | VARCHAR(100) | 昵称 | 必填 |
| qq | VARCHAR(20) | QQ号 | 必填 |
| game_id | VARCHAR(100) | 游戏ID | |
| email | VARCHAR(100) | 邮箱 | |
| join_date | DATE | 加入时间 | |
| stage_role | ENUM | 阶段&角色 | 见下方枚举值 |
| status | ENUM | 状态 | 正常/请假中/已退队/其他 |
| last_training_date | DATE | 最后新训日期 | |
| created_at | TIMESTAMP | 创建时间 | 自动 |
| updated_at | TIMESTAMP | 更新时间 | 自动 |

**阶段&角色枚举值**：
- 未新训
- 新训初期
- 新训一期
- 新训二期
- 新训三期
- 新训准考
- 紫夜
- 紫夜尖兵
- 会长
- 执行官
- 人事
- 总教
- 尖兵教官
- 教官
- 工程师

**状态枚举值**：
- 正常
- 请假中
- 已退队
- 其他

**索引**：
- `idx_username` - 用户名索引
- `idx_qq` - QQ号索引
- `idx_stage_role` - 阶段角色索引
- `idx_status` - 状态索引

---

### 3. 请假记录表 (leave_records)

成员请假记录表

| 字段 | 类型 | 说明 | 备注 |
|------|------|------|------|
| id | INT | 主键ID | 自增 |
| member_id | INT | 成员ID | 外键 -> members.id |
| member_name | VARCHAR(100) | 成员昵称 | 冗余字段，便于查询 |
| qq | VARCHAR(20) | QQ号 | 冗余字段 |
| reason | TEXT | 请假原因 | |
| start_date | DATE | 开始日期 | 必填 |
| end_date | DATE | 结束日期 | 必填 |
| total_days | INT | 总天数 | 计算得出 |
| status | ENUM | 状态 | 请假中/已结束 |
| created_by | INT | 创建人 | 外键 -> admins.id |
| created_at | TIMESTAMP | 创建时间 | 自动 |
| updated_at | TIMESTAMP | 更新时间 | 自动 |

**索引**：
- `idx_member` - 成员索引
- `idx_status` - 状态索引
- `idx_dates` - 日期复合索引

---

### 4. 黑点记录表 (black_point_records)

成员违规黑点记录表

| 字段 | 类型 | 说明 | 备注 |
|------|------|------|------|
| id | INT | 主键ID | 自增 |
| member_id | INT | 成员ID | 外键 -> members.id |
| member_name | VARCHAR(100) | 成员昵称 | 冗余字段 |
| qq | VARCHAR(20) | QQ号 | 冗余字段 |
| reason | TEXT | 黑点原因 | 必填 |
| register_date | DATE | 登记日期 | 必填 |
| recorder_id | INT | 记录人ID | 外键 -> admins.id |
| recorder_name | VARCHAR(100) | 记录人姓名 | 冗余字段 |
| status | ENUM | 状态 | 生效中/已失效 |
| invalid_date | DATE | 失效日期 | |
| created_at | TIMESTAMP | 创建时间 | 自动 |
| updated_at | TIMESTAMP | 更新时间 | 自动 |

**索引**：
- `idx_member` - 成员索引
- `idx_status` - 状态索引
- `idx_register_date` - 登记日期索引

---

### 5. 催促名单表 (reminder_list)

未训练成员催促名单

| 字段 | 类型 | 说明 | 备注 |
|------|------|------|------|
| id | INT | 主键ID | 自增 |
| member_id | INT | 成员ID | 外键 -> members.id, 唯一 |
| member_name | VARCHAR(100) | 成员昵称 | 冗余字段 |
| last_training_date | DATE | 最后新训日期 | |
| days_without_training | INT | 未训天数 | 计算得出 |
| created_at | TIMESTAMP | 创建时间 | 自动 |
| updated_at | TIMESTAMP | 更新时间 | 自动 |

**唯一约束**：
- `unique_member` - 每个成员只能有一条记录

**索引**：
- `idx_days` - 未训天数索引

---

### 6. 退队审批表 (quit_approvals)

成员退队申请审批表

| 字段 | 类型 | 说明 | 备注 |
|------|------|------|------|
| id | INT | 主键ID | 自增 |
| member_id | INT | 成员ID | 外键 -> members.id |
| member_name | VARCHAR(100) | 成员昵称 | 冗余字段 |
| qq | VARCHAR(20) | QQ号 | 冗余字段 |
| apply_date | DATE | 申请日期 | 必填 |
| source_type | ENUM | 退队来源 | 手动/自动 |
| source_admin_id | INT | 来源管理员ID | 手动时填写 |
| source_admin_name | VARCHAR(100) | 来源管理员姓名 | 手动时填写 |
| status | ENUM | 审批状态 | 待审批/已批准/已拒绝 |
| approver_id | INT | 审批人ID | 外键 -> admins.id |
| approver_name | VARCHAR(100) | 审批人姓名 | |
| approval_date | DATE | 审批日期 | |
| remarks | TEXT | 备注 | |
| created_at | TIMESTAMP | 创建时间 | 自动 |
| updated_at | TIMESTAMP | 更新时间 | 自动 |

**索引**：
- `idx_member` - 成员索引
- `idx_status` - 状态索引
- `idx_apply_date` - 申请日期索引

---

### 7. 留队管理表 (retention_records)

特殊情况留队审批记录表

| 字段 | 类型 | 说明 | 备注 |
|------|------|------|------|
| id | INT | 主键ID | 自增 |
| member_id | INT | 成员ID | 外键 -> members.id |
| member_name | VARCHAR(100) | 成员昵称 | 冗余字段 |
| qq | VARCHAR(20) | QQ号 | 冗余字段 |
| stage_role | VARCHAR(50) | 阶段&角色 | |
| last_training_date | DATE | 最后新训日期 | |
| retention_reason | TEXT | 留队原因 | 必填 |
| approver_remarks | TEXT | 批准者备注 | |
| approver_id | INT | 批准者ID | 外键 -> admins.id |
| approver_name | VARCHAR(100) | 批准者姓名 | |
| approval_date | DATE | 批准日期 | 必填 |
| created_at | TIMESTAMP | 创建时间 | 自动 |
| updated_at | TIMESTAMP | 更新时间 | 自动 |

**索引**：
- `idx_member` - 成员索引
- `idx_approval_date` - 批准日期索引

---

## 数据库初始化

### 初始化步骤

1. 确保 MySQL 服务已启动
2. 创建数据库：`CREATE DATABASE ziye_guild CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
3. 执行初始化脚本：`mysql -u用户名 -p密码 ziye_guild < init.sql`

### 默认账号

**管理员账号**：
- 用户名：`admin`
- 密码：`admin123`

**测试成员账号**：
- 用户名：`member`
- 密码：`member123`
- 昵称：测试成员
- QQ：123456789

---

## 数据冗余设计说明

为了提高查询性能和减少JOIN操作，本系统在以下表中使用了数据冗余设计：

1. **成员信息冗余**：在 `leave_records`、`black_point_records`、`quit_approvals`、`retention_records` 等表中冗余存储了 `member_name` 和 `qq`
2. **管理员信息冗余**：在相关表中冗余存储了 `recorder_name`、`approver_name` 等字段

**优点**：
- 查询速度快，无需JOIN
- 保留历史记录准确性（即使原表数据变更）

**注意事项**：
- 更新成员信息时需同步更新相关表
- 建议通过应用层逻辑保证数据一致性

---

## 业务逻辑说明

### 1. 请假状态自动更新
- 当 `end_date < 当前日期` 时，自动将 `status` 更新为 `已结束`
- 成员请假时，自动将 `members.status` 更新为 `请假中`
- 请假结束时，自动将 `members.status` 更新为 `正常`

### 2. 催促名单自动生成
- 定时任务每天检查 `members` 表
- 计算 `DATEDIFF(当前日期, last_training_date)`
- 超过阈值（如7天）的成员自动加入 `reminder_list`

### 3. 自动退队审批
- 催促名单中超过一定天数（如30天）的成员
- 自动创建退队审批记录，`source_type = '自动'`

### 4. 黑点失效逻辑
- 可设置黑点有效期（如90天）
- 自动将过期黑点的 `status` 更新为 `已失效`

---

## 后续扩展建议

1. **操作日志表**：记录所有管理操作
2. **通知表**：系统通知和消息推送
3. **训练记录表**：详细的每次训练记录
4. **考核成绩表**：成员考核评分记录
5. **附件表**：上传文件、图片等
