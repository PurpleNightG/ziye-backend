import express from 'express'
import { pool } from '../config/database.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const router = express.Router()

// 学员登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: '请输入用户名和密码'
      })
    }
    
    // 查询成员（用户名即昵称）
    const [members] = await pool.query(
      'SELECT * FROM members WHERE username = ? OR nickname = ?',
      [username, username]
    )
    
    if (members.length === 0) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      })
    }
    
    const member = members[0]
    
    // 检查成员状态
    if (member.status === '已退队') {
      return res.status(403).json({
        success: false,
        message: '您已退队，无法登录'
      })
    }
    
    // 验证密码
    const isPasswordValid = await bcrypt.compare(password, member.password)
    
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      })
    }
    
    // 生成JWT token
    const token = jwt.sign(
      {
        id: member.id,
        username: member.username,
        nickname: member.nickname,
        role: 'student'
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    )
    
    // 返回成员信息（不含密码）
    const { password: _, ...memberInfo } = member
    
    res.json({
      success: true,
      message: '登录成功',
      data: {
        token,
        member: memberInfo
      }
    })
  } catch (error) {
    console.error('学员登录失败:', error)
    res.status(500).json({
      success: false,
      message: '登录失败，请稍后重试'
    })
  }
})

// 验证token
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: '未提供token'
      })
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    
    // 查询最新的成员信息
    const [members] = await pool.query(
      'SELECT * FROM members WHERE id = ?',
      [decoded.id]
    )
    
    if (members.length === 0 || members[0].status === '已退队') {
      return res.status(403).json({
        success: false,
        message: '账号不存在或已退队'
      })
    }
    
    const { password: _, ...memberInfo } = members[0]
    
    res.json({
      success: true,
      data: {
        member: memberInfo
      }
    })
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Token无效或已过期'
    })
  }
})

// 学员修改密码
router.put('/change-password', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: '未登录'
      })
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    const { oldPassword, newPassword } = req.body
    
    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: '请输入旧密码和新密码'
      })
    }
    
    // 获取成员信息
    const [members] = await pool.query(
      'SELECT * FROM members WHERE id = ?',
      [decoded.id]
    )
    
    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    const member = members[0]
    
    // 验证旧密码
    const isOldPasswordValid = await bcrypt.compare(oldPassword, member.password)
    
    if (!isOldPasswordValid) {
      return res.status(401).json({
        success: false,
        message: '旧密码错误'
      })
    }
    
    // 加密新密码
    const hashedPassword = await bcrypt.hash(newPassword, 10)
    
    // 更新密码
    await pool.query(
      'UPDATE members SET password = ? WHERE id = ?',
      [hashedPassword, decoded.id]
    )
    
    res.json({
      success: true,
      message: '密码修改成功'
    })
  } catch (error) {
    console.error('修改密码失败:', error)
    res.status(500).json({
      success: false,
      message: '修改密码失败'
    })
  }
})

// 检查是否使用默认密码
router.get('/check-default-password', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: '未登录'
      })
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    
    // 获取成员信息
    const [members] = await pool.query(
      'SELECT id, password, qq FROM members WHERE id = ?',
      [decoded.id]
    )
    
    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    const member = members[0]
    
    // 检查密码是否为QQ号（默认密码）
    const isDefaultPassword = await bcrypt.compare(member.qq, member.password)
    
    res.json({
      success: true,
      data: {
        isDefaultPassword
      }
    })
  } catch (error) {
    console.error('检查默认密码失败:', error)
    res.status(500).json({
      success: false,
      message: '检查失败'
    })
  }
})

// 重置默认密码（强制修改，不需要旧密码）
router.post('/reset-default-password', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: '未登录'
      })
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    const { newPassword } = req.body
    
    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: '请输入新密码'
      })
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: '密码长度至少为6位'
      })
    }
    
    // 获取成员信息
    const [members] = await pool.query(
      'SELECT id, password, qq FROM members WHERE id = ?',
      [decoded.id]
    )
    
    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    const member = members[0]
    
    // 验证当前密码是否为默认密码（QQ号）
    const isDefaultPassword = await bcrypt.compare(member.qq, member.password)
    
    if (!isDefaultPassword) {
      return res.status(403).json({
        success: false,
        message: '仅允许重置默认密码'
      })
    }
    
    // 验证新密码不能与默认密码相同
    if (newPassword === member.qq) {
      return res.status(400).json({
        success: false,
        message: '新密码不能与默认密码（QQ号）相同'
      })
    }
    
    // 加密新密码
    const hashedPassword = await bcrypt.hash(newPassword, 10)
    
    // 更新密码
    await pool.query(
      'UPDATE members SET password = ? WHERE id = ?',
      [hashedPassword, decoded.id]
    )
    
    res.json({
      success: true,
      message: '密码重置成功'
    })
  } catch (error) {
    console.error('重置密码失败:', error)
    res.status(500).json({
      success: false,
      message: '重置密码失败'
    })
  }
})

export default router
