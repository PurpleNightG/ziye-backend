import bcrypt from 'bcryptjs'

// 生成密码哈希
async function generatePasswordHash() {
  const adminPassword = 'admin123'
  const studentPassword = 'student123'
  
  const adminHash = await bcrypt.hash(adminPassword, 10)
  const studentHash = await bcrypt.hash(studentPassword, 10)
  
  console.log('=== 密码哈希生成完成 ===\n')
  console.log('管理员账号:')
  console.log('  用户名: admin')
  console.log('  密码: admin123')
  console.log('  哈希值:', adminHash)
  console.log('')
  console.log('学员账号:')
  console.log('  用户名: student')
  console.log('  密码: student123')
  console.log('  哈希值:', studentHash)
  console.log('\n=== SQL插入语句 ===\n')
  console.log(`INSERT INTO admins (username, password, name, email) VALUES ('admin', '${adminHash}', '系统管理员', 'admin@ziye.com') ON DUPLICATE KEY UPDATE password='${adminHash}';`)
  console.log('')
  console.log(`INSERT INTO students (username, password, name, qq, status) VALUES ('student', '${studentHash}', '测试学员', '123456789', 'training') ON DUPLICATE KEY UPDATE password='${studentHash}';`)
}

generatePasswordHash()
