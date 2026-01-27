import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from '../config/database.js'

const router = express.Router()

// 登录接口
router.post('/login', async (req, res) => {
  try {
    const { username, password, userType } = req.body
    
    // 详细日志
    console.log('=== 登录请求 ===')
    console.log('用户名:', username)
    console.log('用户类型:', userType)
    console.log('密码长度:', password?.length)

    // 验证必填字段
    if (!username || !password || !userType) {
      console.log('❌ 缺少必填字段')
      return res.status(400).json({ 
        success: false, 
        message: '请提供用户名、密码和用户类型' 
      })
    }

    // 根据用户类型查询不同的表
    let tableName = userType === 'admin' ? 'admins' : 'students'
    console.log('查询表:', tableName)
    
    // 查询用户
    const [users] = await pool.query(
      `SELECT * FROM ${tableName} WHERE username = ?`,
      [username]
    )
    
    console.log('查询结果数量:', users.length)

    if (users.length === 0) {
      console.log('❌ 用户不存在')
      return res.status(401).json({ 
        success: false, 
        message: '用户名或密码错误' 
      })
    }

    const user = users[0]
    console.log('找到用户:', user.username)
    console.log('数据库密码哈希:', user.password.substring(0, 30) + '...')

    // 验证密码
    const isPasswordValid = await bcrypt.compare(password, user.password)
    console.log('密码验证结果:', isPasswordValid ? '✅ 成功' : '❌ 失败')
    
    if (!isPasswordValid) {
      console.log('❌ 密码错误')
      return res.status(401).json({ 
        success: false, 
        message: '用户名或密码错误' 
      })
    }
    
    console.log('✅ 登录成功')

    // 生成JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        userType: userType 
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    // 返回成功响应
    res.json({
      success: true,
      message: '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          name: user.name || username,
          userType: userType
        }
      }
    })

  } catch (error) {
    console.error('登录错误:', error)
    res.status(500).json({ 
      success: false, 
      message: '服务器错误，请稍后重试' 
    })
  }
})

// 验证token接口
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')

    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: '未提供认证令牌' 
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    res.json({
      success: true,
      data: {
        id: decoded.id,
        username: decoded.username,
        userType: decoded.userType
      }
    })

  } catch (error) {
    console.error('Token验证错误:', error)
    res.status(401).json({ 
      success: false, 
      message: '认证令牌无效或已过期' 
    })
  }
})

// 管理员修改密码接口
router.put('/change-password', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: '未提供认证令牌' 
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const { oldPassword, newPassword } = req.body

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: '请提供旧密码和新密码' 
      })
    }

    // 获取当前用户信息
    const tableName = decoded.userType === 'admin' ? 'admins' : 'students'
    const [users] = await pool.query(
      `SELECT * FROM ${tableName} WHERE id = ?`,
      [decoded.id]
    )

    if (users.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: '用户不存在' 
      })
    }

    const user = users[0]

    // 验证旧密码
    const isPasswordValid = await bcrypt.compare(oldPassword, user.password)
    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        message: '旧密码错误' 
      })
    }

    // 加密新密码
    const hashedPassword = await bcrypt.hash(newPassword, 10)

    // 更新密码
    await pool.query(
      `UPDATE ${tableName} SET password = ? WHERE id = ?`,
      [hashedPassword, decoded.id]
    )

    res.json({
      success: true,
      message: '密码修改成功'
    })

  } catch (error) {
    console.error('修改密码错误:', error)
    res.status(500).json({ 
      success: false, 
      message: '服务器错误，请稍后重试' 
    })
  }
})

export default router
