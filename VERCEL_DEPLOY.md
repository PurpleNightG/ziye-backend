# Vercel + Cloudflare 部署指南

## 📦 部署步骤

### 1. 推送后端代码到GitHub

```bash
cd server
git add .
git commit -m "feat: 优化Vercel配置，支持serverless部署"
git push
```

### 2. Vercel部署配置

1. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 "Import Project"
3. 选择你的GitHub仓库
4. **重要：设置根目录为 `server`**
5. 添加环境变量：
   - `DB_HOST`: 你的数据库主机
   - `DB_PORT`: 数据库端口
   - `DB_USER`: 数据库用户名
   - `DB_PASSWORD`: 数据库密码
   - `DB_NAME`: 数据库名称
   - `JWT_SECRET`: JWT密钥
   - `NODE_ENV`: production
   - `VERCEL`: 1

### 3. Cloudflare DNS配置

在Cloudflare中配置CNAME记录：

- **类型**: CNAME
- **名称**: `api` （完整域名将是 api.sh01.eu.org）
- **目标**: `你的vercel项目.vercel.app` （例如：ziye-backend.vercel.app）
- **代理状态**: ✅ 已代理（橙色云朵图标）

### 4. Vercel自定义域名

在Vercel项目设置中：

1. 进入 Settings → Domains
2. 添加自定义域名：`api.sh01.eu.org`
3. 按照提示验证域名

### 5. 测试API

部署完成后，测试以下URL：

```bash
# 健康检查
curl https://api.sh01.eu.org/api/health

# 应该返回：
# {"status":"ok","message":"紫夜公会后端服务运行中"}
```

## 🔧 故障排查

### 问题1：404 Not Found

**可能原因：**
- Vercel项目根目录设置错误（应该是 `server`）
- 路由配置问题
- 代码未正确部署

**解决方法：**
1. 检查Vercel项目设置中的 "Root Directory" 是否为 `server`
2. 查看Vercel部署日志，确认部署成功
3. 访问 `https://你的项目.vercel.app/api/health` 测试原始URL

### 问题2：CORS错误

**解决方法：**
已在 `index.js` 中配置允许 `sh01.eu.org` 和所有 `github.io` 域名

### 问题3：数据库连接失败

**解决方法：**
1. 检查Vercel环境变量是否正确设置
2. 确认数据库允许来自Vercel的IP连接
3. 查看Vercel函数日志

## 📝 重要注意事项

1. **Serverless限制**：
   - 每个请求最多执行10秒（免费版）
   - 不支持持久连接
   - 数据库连接池需要优化

2. **Cloudflare代理**：
   - 启用代理可以隐藏真实IP
   - 可能影响某些功能，如WebSocket
   - 可以配置缓存规则优化性能

3. **环境变量**：
   - 所有敏感信息必须通过Vercel环境变量设置
   - 不要在代码中硬编码密钥

## 🚀 部署命令

```bash
# 1. 提交代码
git add .
git commit -m "update backend"
git push

# 2. Vercel会自动检测并部署
# 3. 查看部署状态：https://vercel.com/dashboard
```
