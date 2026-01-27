# 紫夜公会后端服务

## 📋 数据库信息

已配置SQLPub数据库：
- **主机**: mysql6.sqlpub.com:3311
- **数据库名**: png_management
- **用户名**: ndyian_zoz
- **密码**: 已配置在 `.env` 文件中

## 🚀 快速开始

### 1. 安装依赖

```bash
cd server
npm install
```

### 2. 初始化数据库

在SQLPub管理面板中执行 `init.sql` 文件，创建必要的表结构和测试账号。

或者使用MySQL客户端连接后执行：

```bash
mysql -h mysql6.sqlpub.com -P 3311 -u ndyian_zoz -p png_management < init.sql
```

### 3. 启动服务器

```bash
# 开发模式（自动重启）
npm run dev

# 生产模式
npm start
```

服务器将运行在 `http://localhost:3000`

## 🔑 测试账号

数据库初始化后会自动创建以下测试账号：

### 管理员账号
- **用户名**: admin
- **密码**: admin123

### 学员账号
- **用户名**: student
- **密码**: student123

## 📡 API接口

### 登录接口
```
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin123",
  "userType": "admin" // 或 "student"
}
```

### Token验证接口
```
GET /api/auth/verify
Authorization: Bearer <token>
```

### 健康检查
```
GET /api/health
```

## 📊 数据库表结构

- **admins** - 管理员表
- **students** - 学员表
- **courses** - 课程表
- **student_progress** - 学员课程进度表
- **leave_records** - 请假记录表
- **violation_records** - 黑点记录表
- **assessment_records** - 考核记录表

## 🔐 安全说明

- 密码使用 bcrypt 加密存储
- JWT token 有效期为 7 天
- 请妥善保管 `.env` 文件中的数据库密码和JWT密钥
- **重要**: 生产环境请修改 `JWT_SECRET` 为更安全的值

## ⚠️ 注意事项

1. SQLPub提供的是免费数据库，密码只显示一次，请妥善保存
2. 建议定期备份数据
3. 不要在 GitHub 等公开平台上传 `.env` 文件
4. 生产环境建议使用更安全的数据库配置

## 📝 开发提示

- 数据库连接池已配置，最大连接数为 10
- 所有时间戳使用 TIMESTAMP 类型
- 字符集使用 utf8mb4，支持emoji等特殊字符
- 所有表都使用 InnoDB 引擎，支持事务
