import mysql from 'mysql2/promise'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config()

async function runMigration() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'purple_night',
    multipleStatements: true
  })

  try {
    console.log('开始执行公开视频表迁移...')
    
    const migrationPath = path.join(__dirname, 'migrations', '009_create_public_videos_table.sql')
    const sql = await fs.readFile(migrationPath, 'utf-8')
    
    await connection.query(sql)
    console.log('✓ 公开视频表创建成功')
    
  } catch (error) {
    console.error('迁移失败:', error)
    throw error
  } finally {
    await connection.end()
  }
}

runMigration()
  .then(() => {
    console.log('迁移完成！')
    process.exit(0)
  })
  .catch((error) => {
    console.error('迁移失败:', error)
    process.exit(1)
  })
