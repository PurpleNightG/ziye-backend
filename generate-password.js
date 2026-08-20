import bcrypt from 'bcryptjs'

// 生成密码哈希
async function generatePasswordHash() {
  const password = '123456'
  
  const hash = await bcrypt.hash(password, 10)
  
  console.log('=== 密码哈希生成完成 ===\n')
  console.log('密码:', password)
  console.log('哈希值:', hash)
  console.log('\n=== 用于数据库的哈希值 ===')
  console.log(hash)
}

generatePasswordHash()
