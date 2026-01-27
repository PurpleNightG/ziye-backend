import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取所有成员及其进度信息
router.get('/members', async (req, res) => {
  try {
    const [members] = await pool.query(`
      SELECT 
        m.id,
        m.nickname as name,
        m.stage_role as status,
        m.join_date,
        COUNT(DISTINCT scp.course_id) as completed_courses,
        (SELECT COUNT(*) FROM courses) as total_courses
      FROM members m
      LEFT JOIN student_course_progress scp ON m.id = scp.member_id AND scp.progress = 100
      WHERE m.status != '已退队'
      GROUP BY m.id
      ORDER BY m.join_date DESC
    `)
    
    res.json({
      success: true,
      data: members
    })
  } catch (error) {
    console.error('获取成员列表失败:', error)
    res.status(500).json({
      success: false,
      message: '获取成员列表失败'
    })
  }
})

// 获取单个成员的所有课程进度
router.get('/member/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params
    
    // 获取所有课程及该成员的进度
    const [courses] = await pool.query(`
      SELECT 
        c.id,
        c.code,
        c.name,
        c.category,
        c.difficulty,
        c.hours,
        COALESCE(scp.progress, 0) as progress
      FROM courses c
      LEFT JOIN student_course_progress scp 
        ON c.id = scp.course_id AND scp.member_id = ?
      ORDER BY c.\`order\`
    `, [memberId])
    
    res.json({
      success: true,
      data: courses
    })
  } catch (error) {
    console.error('获取成员课程进度失败:', error)
    res.status(500).json({
      success: false,
      message: '获取成员课程进度失败'
    })
  }
})

// 更新单个成员的单个课程进度
router.put('/member/:memberId/course/:courseId', async (req, res) => {
  try {
    const { memberId, courseId } = req.params
    const { progress } = req.body
    
    if (![0, 10, 20, 50, 75, 100].includes(progress)) {
      return res.status(400).json({
        success: false,
        message: '进度值必须是 0, 10, 20, 50, 75, 100 之一'
      })
    }
    
    // 如果进度是0，删除记录；否则插入或更新
    if (progress === 0) {
      await pool.query(
        'DELETE FROM student_course_progress WHERE member_id = ? AND course_id = ?',
        [memberId, courseId]
      )
    } else {
      await pool.query(`
        INSERT INTO student_course_progress (member_id, course_id, progress)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE progress = ?
      `, [memberId, courseId, progress, progress])
    }
    
    res.json({
      success: true,
      message: '进度更新成功'
    })
  } catch (error) {
    console.error('更新进度失败:', error)
    res.status(500).json({
      success: false,
      message: '更新进度失败'
    })
  }
})

// 批量更新多个成员的单个课程进度
router.put('/batch/course/:courseId', async (req, res) => {
  try {
    const { courseId } = req.params
    const { memberIds, progress } = req.body
    
    if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'memberIds参数必须是非空数组'
      })
    }
    
    if (![0, 10, 20, 50, 75, 100].includes(progress)) {
      return res.status(400).json({
        success: false,
        message: '进度值必须是 0, 10, 20, 50, 75, 100 之一'
      })
    }
    
    const connection = await pool.getConnection()
    await connection.beginTransaction()
    
    try {
      for (const memberId of memberIds) {
        if (progress === 0) {
          await connection.query(
            'DELETE FROM student_course_progress WHERE member_id = ? AND course_id = ?',
            [memberId, courseId]
          )
        } else {
          await connection.query(`
            INSERT INTO student_course_progress (member_id, course_id, progress)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE progress = ?
          `, [memberId, courseId, progress, progress])
        }
      }
      
      await connection.commit()
      
      res.json({
        success: true,
        message: `已成功更新 ${memberIds.length} 名成员的进度`
      })
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('批量更新进度失败:', error)
    res.status(500).json({
      success: false,
      message: '批量更新进度失败'
    })
  }
})

// 批量更新单个成员的多个课程进度
router.put('/batch/member/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params
    const { updates } = req.body // updates: [{ courseId, progress }, ...]
    
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'updates参数必须是非空数组'
      })
    }
    
    const connection = await pool.getConnection()
    await connection.beginTransaction()
    
    try {
      for (const { courseId, progress } of updates) {
        if (![0, 10, 20, 50, 75, 100].includes(progress)) {
          throw new Error(`无效的进度值: ${progress}`)
        }
        
        if (progress === 0) {
          await connection.query(
            'DELETE FROM student_course_progress WHERE member_id = ? AND course_id = ?',
            [memberId, courseId]
          )
        } else {
          await connection.query(`
            INSERT INTO student_course_progress (member_id, course_id, progress)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE progress = ?
          `, [memberId, courseId, progress, progress])
        }
      }
      
      await connection.commit()
      
      res.json({
        success: true,
        message: `已成功更新 ${updates.length} 门课程的进度`
      })
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('批量更新成员课程进度失败:', error)
    res.status(500).json({
      success: false,
      message: error.message || '批量更新成员课程进度失败'
    })
  }
})

export default router
