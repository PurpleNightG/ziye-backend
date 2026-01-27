import { pool } from './config/database.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function runMigration() {
  try {
    console.log('开始执行系统配置表迁移...')
    
    // 读取SQL文件
    const sqlFile = path.join(__dirname, 'migrations', '006_create_system_settings_table.sql')
    const sql = fs.readFileSync(sqlFile, 'utf8')
    
    // 执行SQL
    const statements = sql.split(';').filter(s => s.trim())
    for (const statement of statements) {
      if (statement.trim()) {
        await pool.query(statement)
      }
    }
    
    console.log('✅ 系统配置表迁移完成！')
    console.log('✅ 默认超时天数已设置为7天')
    
  } catch (error) {
    console.error('❌ 迁移失败:', error)
    throw error
  } finally {
    await pool.end()
  }
}

runMigration()
