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
      
      // 第二阶段：更新为最终的code、order和name
      for (const course of courses) {
        await connection.query(
          'UPDATE courses SET code = ?, `order` = ?, name = ? WHERE id = ?',
          [course.code, course.order, course.name, course.id]
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

const DEFAULT_CATEGORIES = [
  { name: '入门课程', color: 'purple' },
  { name: '标准技能一阶课程', color: 'blue' },
  { name: '标准技能二阶课程', color: 'cyan' },
  { name: '团队训练', color: 'yellow' },
  { name: '进阶课程', color: 'orange' },
]
const DEFAULT_DIFFICULTIES = [
  { name: '初级', color: 'green' },
  { name: '中级', color: 'blue' },
  { name: '高级', color: 'red' },
]
const ALLOWED_COLORS = new Set([
  'purple',
  'blue',
  'cyan',
  'yellow',
  'orange',
  'green',
  'red',
  'pink',
  'gray',
  'blackgold',
  'blacksilver',
  'blackcopper',
  'blackrose',
  'blackice',
  'blackviolet',
  'blackemerald',
])

function normalizeColor(raw, fallback = 'purple') {
  const c = String(raw || '').trim().toLowerCase()
  return ALLOWED_COLORS.has(c) ? c : fallback
}

async function ensureCourseMetaOptions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS course_meta_options (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kind ENUM('category', 'difficulty') NOT NULL,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(32) NOT NULL DEFAULT 'purple',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_kind_name (kind, name),
      INDEX idx_kind_order (kind, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  try {
    await pool.query(`
      ALTER TABLE course_meta_options
      ADD COLUMN color VARCHAR(32) NOT NULL DEFAULT 'purple' AFTER name
    `)
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e
  }
}

async function listMetaOptions(kind) {
  await ensureCourseMetaOptions()
  const [rows] = await pool.query(
    `SELECT name, color, sort_order FROM course_meta_options WHERE kind = ? ORDER BY sort_order ASC, id ASC`,
    [kind]
  )
  if (rows.length) {
    return rows.map((r) => ({
      name: r.name,
      color: normalizeColor(r.color),
    }))
  }

  const defaults = kind === 'category' ? DEFAULT_CATEGORIES : DEFAULT_DIFFICULTIES
  const col = kind === 'category' ? 'category' : 'difficulty'
  const items = defaults.map((d) => ({ ...d }))
  try {
    const [used] = await pool.query(
      `SELECT DISTINCT \`${col}\` AS name FROM courses WHERE \`${col}\` IS NOT NULL AND \`${col}\` != ''`
    )
    const palette = [...ALLOWED_COLORS]
    for (const row of used) {
      if (row.name && !items.some((x) => x.name === row.name)) {
        items.push({
          name: row.name,
          color: palette[items.length % palette.length],
        })
      }
    }
  } catch {
    // courses 表可能尚未创建
  }
  for (let i = 0; i < items.length; i++) {
    await pool.query(
      `INSERT IGNORE INTO course_meta_options (kind, name, color, sort_order) VALUES (?, ?, ?, ?)`,
      [kind, items[i].name, items[i].color, i]
    )
  }
  return items
}

async function replaceMetaOptions(kind, input) {
  await ensureCourseMetaOptions()
  const cleaned = []
  const seen = new Set()
  const palette = [...ALLOWED_COLORS]
  for (let i = 0; i < (input || []).length; i++) {
    const raw = input[i]
    const name = String(typeof raw === 'string' ? raw : raw?.name || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const color = normalizeColor(
      typeof raw === 'object' ? raw?.color : null,
      palette[cleaned.length % palette.length]
    )
    cleaned.push({ name, color })
  }
  if (!cleaned.length) {
    throw Object.assign(new Error('至少保留一项'), { status: 400 })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`DELETE FROM course_meta_options WHERE kind = ?`, [kind])
    for (let i = 0; i < cleaned.length; i++) {
      await conn.query(
        `INSERT INTO course_meta_options (kind, name, color, sort_order) VALUES (?, ?, ?, ?)`,
        [kind, cleaned[i].name, cleaned[i].color, i]
      )
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
  return cleaned
}

// 获取类别配置（必须在/:id之前）
router.get('/config/categories', async (req, res) => {
  try {
    const categories = await listMetaOptions('category')
    res.json({ success: true, data: categories })
  } catch (error) {
    console.error('获取类别配置失败:', error)
    res.status(500).json({
      success: false,
      message: '获取类别配置失败',
    })
  }
})

// 更新类别配置（必须在/:id之前）
router.put('/config/categories', async (req, res) => {
  try {
    const categories = await replaceMetaOptions('category', req.body?.categories)
    res.json({ success: true, data: categories, message: '类别配置已保存' })
  } catch (error) {
    console.error('更新类别配置失败:', error)
    res.status(error.status || 500).json({
      success: false,
      message: error.status === 400 ? error.message : '更新类别配置失败',
    })
  }
})

// 获取难度配置（必须在/:id之前）
router.get('/config/difficulties', async (req, res) => {
  try {
    const difficulties = await listMetaOptions('difficulty')
    res.json({ success: true, data: difficulties })
  } catch (error) {
    console.error('获取难度配置失败:', error)
    res.status(500).json({
      success: false,
      message: '获取难度配置失败',
    })
  }
})

// 更新难度配置（必须在/:id之前）
router.put('/config/difficulties', async (req, res) => {
  try {
    const difficulties = await replaceMetaOptions('difficulty', req.body?.difficulties)
    res.json({ success: true, data: difficulties, message: '难度配置已保存' })
  } catch (error) {
    console.error('更新难度配置失败:', error)
    res.status(error.status || 500).json({
      success: false,
      message: error.status === 400 ? error.message : '更新难度配置失败',
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
      'SELECT id, `order` FROM courses WHERE id = ?',
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
      order ?? existing[0].order,
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
