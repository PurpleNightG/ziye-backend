import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pool } from './config/database.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function runMigration() {
  try {
    console.log('📚 开始创建课程表并插入初始数据...')
    
    // 读取迁移文件
    const migrationPath = path.join(__dirname, 'migrations', '004_create_courses_table.sql')
    const sql = fs.readFileSync(migrationPath, 'utf8')
    
    // 分割SQL语句（按分号分割，但保留INSERT语句）
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0)
    
    // 执行每条SQL语句
    for (const statement of statements) {
      if (statement) {
        await pool.query(statement)
      }
    }
    
    console.log('✅ 课程表创建成功！')
    console.log('✅ 已插入29门初始课程')
    
    // 查询并显示课程数量
    const [result] = await pool.query('SELECT COUNT(*) as count FROM courses')
    console.log(`📊 当前课程总数: ${result[0].count}`)
    
    // 显示课程列表
    const [courses] = await pool.query('SELECT code, name, category FROM courses ORDER BY `order`')
    console.log('\n📋 课程列表:')
    courses.forEach(course => {
      console.log(`   ${course.code} - ${course.name} (${course.category})`)
    })
    
    process.exit(0)
  } catch (error) {
    console.error('❌ 迁移失败:', error.message)
    process.exit(1)
  }
}

runMigration()
