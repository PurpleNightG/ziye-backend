import { pool } from './config/database.js'
import bcrypt from 'bcryptjs'

async function testDatabase() {
  try {
    console.log('=== 测试数据库连接和数据 ===\n')
    
    // 查询管理员
    console.log('1. 查询管理员表:')
    const [admins] = await pool.query('SELECT * FROM admins')
    console.log(`   找到 ${admins.length} 个管理员账号`)
    if (admins.length > 0) {
      console.log('   管理员列表:')
      admins.forEach(admin => {
        console.log(`   - ID: ${admin.id}, 用户名: ${admin.username}, 姓名: ${admin.name}`)
        console.log(`     密码哈希: ${admin.password.substring(0, 30)}...`)
      })
    }
    
    console.log('\n2. 查询学员表:')
    const [students] = await pool.query('SELECT * FROM students')
    console.log(`   找到 ${students.length} 个学员账号`)
    if (students.length > 0) {
      console.log('   学员列表:')
      students.forEach(student => {
        console.log(`   - ID: ${student.id}, 用户名: ${student.username}, 姓名: ${student.name}`)
        console.log(`     密码哈希: ${student.password.substring(0, 30)}...`)
      })
    }
    
    // 测试密码验证
    console.log('\n3. 测试密码验证:')
    if (admins.length > 0) {
      const testPassword = 'admin123'
      const isValid = await bcrypt.compare(testPassword, admins[0].password)
      console.log(`   管理员密码 "${testPassword}" 验证: ${isValid ? '✅ 成功' : '❌ 失败'}`)
    }
    
    if (students.length > 0) {
      const testPassword = 'student123'
      const isValid = await bcrypt.compare(testPassword, students[0].password)
      console.log(`   学员密码 "${testPassword}" 验证: ${isValid ? '✅ 成功' : '❌ 失败'}`)
    }
    
    console.log('\n=== 测试完成 ===')
    process.exit(0)
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    process.exit(1)
  }
}

testDatabase()
