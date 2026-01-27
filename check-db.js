import { pool } from './config/database.js'

async function checkDatabase() {
  try {
    console.log('正在检查数据库...')
    
    // 检查members表结构
    const [columns] = await pool.query('DESCRIBE members')
    console.log('\n=== members表结构 ===')
    columns.forEach(col => {
      console.log(`${col.Field}: ${col.Type} ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`)
    })
    
    // 检查是否有remarks字段
    const hasRemarks = columns.some(col => col.Field === 'remarks')
    console.log(`\n✓ remarks字段存在: ${hasRemarks ? '是' : '否'}`)
    
    if (!hasRemarks) {
      console.log('\n⚠️ 需要添加remarks字段，执行以下SQL:')
      console.log('ALTER TABLE members ADD COLUMN remarks TEXT COMMENT \'备注信息\' AFTER last_training_date;')
    }
    
    // 测试更新操作
    console.log('\n=== 测试更新成员信息 ===')
    const [members] = await pool.query('SELECT id FROM members LIMIT 1')
    if (members.length > 0) {
      const testId = members[0].id
      console.log(`测试ID: ${testId}`)
      
      try {
        await pool.query(`
          UPDATE members SET
            remarks = ?
          WHERE id = ?
        `, ['测试备注', testId])
        console.log('✓ 更新成功')
      } catch (error) {
        console.error('✗ 更新失败:', error.message)
      }
    }
    
    process.exit(0)
  } catch (error) {
    console.error('检查失败:', error)
    process.exit(1)
  }
}

checkDatabase()
