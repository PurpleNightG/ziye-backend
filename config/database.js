import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

// 创建数据库连接池
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,  // 减少连接池大小，避免超过服务器限制
  maxIdle: 3,  // 最大空闲连接数
  idleTimeout: 60000,  // 空闲连接60秒后释放
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
})

// 测试数据库连接
async function testConnection() {
  try {
    const connection = await pool.getConnection()
    console.log('✅ 数据库连接成功!')
    console.log(`📊 数据库: ${process.env.DB_NAME}`)
    console.log(`🔗 主机: ${process.env.DB_HOST}:${process.env.DB_PORT}`)
    connection.release()
    return true
  } catch (error) {
    console.error('❌ 数据库连接失败:', error.message)
    return false
  }
}

export { pool, testConnection }
