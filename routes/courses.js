import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取所有课程
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM courses
      ORDER BY \`order\` ASC
    `)
    
    res.json({
      success: true,
      data: rows
    })
  } catch (error) {
    console.error('获取课程列表失败:', error)
    res.status(500).json({
      success: false,
      message: '获取课程列表失败'
    })
  }
})

// 更新课程顺序（必须在/:id之前）
router.put('/order', async (req, res) => {
  try {
    const { courses } = req.body
    
    if (!courses || !Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'courses参数必须是非空数组'
      })
    }
    
    // 使用事务来确保所有更新要么全部成功要么全部失败
    const connection = await pool.getConnection()
    await connection.beginTransaction()
    
    try {
      // 两阶段更新：先设置临时code避免唯一键冲突
      // 第一阶段：给所有要更新的课程设置临时code（使用负数ID）
      for (const course of courses) {
        await connection.query(
          'UPDATE courses SET code = ? WHERE id = ?',
          [`tmp${course.id}`, course.id]  // 使用 tmp + id，如 tmp1, tmp2
        )
      }
      
      // 第二阶段：更新为最终的code和order
      for (const course of courses) {
        await connection.query(
          'UPDATE courses SET code = ?, `order` = ? WHERE id = ?',
          [course.code, course.order, course.id]
        )
      }
      
      await connection.commit()
      
      res.json({
        success: true,
        message: '课程顺序更新成功'
      })
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error('更新课程顺序失败:', error)
    res.status(500).json({
      success: false,
      message: '更新课程顺序失败'
    })
  }
})

// 批量删除课程（必须在/:id之前）
router.post('/batch/delete', async (req, res) => {
  try {
    const { ids } = req.body
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'ids参数必须是非空数组'
      })
    }
    
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(
      `DELETE FROM courses WHERE id IN (${placeholders})`,
      ids
    )
    
    res.json({
      success: true,
      message: `成功删除 ${ids.length} 门课程`
    })
  } catch (error) {
    console.error('批量删除课程失败:', error)
    res.status(500).json({
      success: false,
      message: '批量删除课程失败'
    })
  }
})

// 批量更新课程（必须在/:id之前）
router.put('/batch/update', async (req, res) => {
  try {
    const { ids, updates } = req.body
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'ids参数必须是非空数组'
      })
    }
    
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'updates参数不能为空'
      })
    }
    
    // 构建SET子句
    const setClauses = []
    const values = []
    
    if (updates.category) {
      setClauses.push('category = ?')
      values.push(updates.category)
    }
    if (updates.difficulty) {
      setClauses.push('difficulty = ?')
      values.push(updates.difficulty)
    }
    if (updates.hours) {
      setClauses.push('hours = ?')
      values.push(updates.hours)
    }
    
    if (setClauses.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有有效的更新字段'
      })
    }
    
    const placeholders = ids.map(() => '?').join(',')
    values.push(...ids)
    
    await pool.query(
      `UPDATE courses SET ${setClauses.join(', ')} WHERE id IN (${placeholders})`,
      values
    )
    
    res.json({
      success: true,
      message: `成功更新 ${ids.length} 门课程`
    })
  } catch (error) {
    console.error('批量更新课程失败:', error)
    res.status(500).json({
      success: false,
      message: '批量更新课程失败'
    })
  }
})

// 获取类别配置（必须在/:id之前）
router.get('/config/categories', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT category FROM courses
      ORDER BY MIN(\`order\`)
    `)
    
    const categories = rows.map(row => row.category)
    
    res.json({
      success: true,
      data: categories
    })
  } catch (error) {
    console.error('获取类别配置失败:', error)
    res.status(500).json({
      success: false,
      message: '获取类别配置失败'
    })
  }
})

// 获取难度配置（必须在/:id之前）
router.get('/config/difficulties', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT difficulty FROM courses
      ORDER BY 
        CASE difficulty
          WHEN '初级' THEN 1
          WHEN '中级' THEN 2
          WHEN '高级' THEN 3
          ELSE 4
        END
    `)
    
    const difficulties = rows.map(row => row.difficulty)
    
    res.json({
      success: true,
      data: difficulties
    })
  } catch (error) {
    console.error('获取难度配置失败:', error)
    res.status(500).json({
      success: false,
      message: '获取难度配置失败'
    })
  }
})

// 获取单个课程
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    const [rows] = await pool.query(
      'SELECT * FROM courses WHERE id = ?',
      [id]
    )
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '课程不存在'
      })
    }
    
    res.json({
      success: true,
      data: rows[0]
    })
  } catch (error) {
    console.error('获取课程失败:', error)
    res.status(500).json({
      success: false,
      message: '获取课程失败'
    })
  }
})

// 创建课程
router.post('/', async (req, res) => {
  try {
    const {
      code,
      name,
      category,
      difficulty,
      hours,
      order,
      description
    } = req.body
    
    if (!code || !name || !category || !difficulty || !hours) {
      return res.status(400).json({
        success: false,
        message: '课程编号、名称、类别、难度和课时为必填项'
      })
    }
    
    // 检查编号是否重复
    const [existing] = await pool.query(
      'SELECT id FROM courses WHERE code = ?',
      [code]
    )
    
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: '课程编号已存在'
      })
    }
    
    // 如果没有提供order，使用最大order+1
    let finalOrder = order
    if (!finalOrder) {
      const [maxOrder] = await pool.query(
        'SELECT MAX(`order`) as maxOrder FROM courses'
      )
      finalOrder = (maxOrder[0].maxOrder || 0) + 1
    } else {
      // 如果指定了order，需要将该位置及之后的课程order值+1
      await pool.query(
        'UPDATE courses SET `order` = `order` + 1 WHERE `order` >= ?',
        [finalOrder]
      )
    }
    
    const [result] = await pool.query(`
      INSERT INTO courses (
        code,
        name,
        category,
        difficulty,
        hours,
        \`order\`,
        description
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      code,
      name,
      category,
      difficulty,
      hours,
      finalOrder,
      description || ''
    ])
    
    res.json({
      success: true,
      message: '课程创建成功',
      data: {
        id: result.insertId,
        code,
        name,
        category,
        difficulty,
        hours,
        order: finalOrder,
        description: description || ''
      }
    })
  } catch (error) {
    console.error('创建课程失败:', error)
    res.status(500).json({
      success: false,
      message: '创建课程失败'
    })
  }
})

// 更新课程
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const {
      code,
      name,
      category,
      difficulty,
      hours,
      order,
      description
    } = req.body
    
    // 检查课程是否存在
    const [existing] = await pool.query(
      'SELECT id FROM courses WHERE id = ?',
      [id]
    )
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: '课程不存在'
      })
    }
    
    // 如果修改了编号，检查新编号是否重复
    if (code) {
      const [duplicate] = await pool.query(
        'SELECT id FROM courses WHERE code = ? AND id != ?',
        [code, id]
      )
      
      if (duplicate.length > 0) {
        return res.status(409).json({
          success: false,
          message: '课程编号已存在'
        })
      }
    }
    
    await pool.query(`
      UPDATE courses SET
        code = ?,
        name = ?,
        category = ?,
        difficulty = ?,
        hours = ?,
        \`order\` = ?,
        description = ?
      WHERE id = ?
    `, [
      code,
      name,
      category,
      difficulty,
      hours,
      order,
      description || '',
      id
    ])
    
    res.json({
      success: true,
      message: '课程更新成功'
    })
  } catch (error) {
    console.error('更新课程失败:', error)
    res.status(500).json({
      success: false,
      message: '更新课程失败'
    })
  }
})

// 删除课程
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    await pool.query('DELETE FROM courses WHERE id = ?', [id])
    
    res.json({
      success: true,
      message: '课程删除成功'
    })
  } catch (error) {
    console.error('删除课程失败:', error)
    res.status(500).json({
      success: false,
      message: '删除课程失败'
    })
  }
})

export default router
