import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// 获取所有公开视频
router.get('/', async (req, res) => {
  try {
    const [videos] = await pool.query(`
      SELECT 
        pv.*,
        m.nickname as creator_name
      FROM public_videos pv
      LEFT JOIN members m ON pv.created_by = m.id
      ORDER BY pv.created_at DESC
    `)
    res.json({ success: true, data: videos })
  } catch (error) {
    console.error('获取公开视频失败:', error)
    res.status(500).json({ success: false, message: '获取公开视频失败' })
  }
})

// 获取单个公开视频
router.get('/:id', async (req, res) => {
  try {
    const [videos] = await pool.query(`
      SELECT 
        pv.*,
        m.nickname as creator_name
      FROM public_videos pv
      LEFT JOIN members m ON pv.created_by = m.id
      WHERE pv.id = ?
    `, [req.params.id])
    
    if (videos.length === 0) {
      return res.status(404).json({ success: false, message: '视频不存在' })
    }
    
    res.json({ success: true, data: videos[0] })
  } catch (error) {
    console.error('获取公开视频失败:', error)
    res.status(500).json({ success: false, message: '获取公开视频失败' })
  }
})

// 创建公开视频
router.post('/', async (req, res) => {
  try {
    const { title, participant_a, participant_b, assessment_date, video_url, description, created_by } = req.body
    
    if (!title || !participant_a || !participant_b || !assessment_date || !video_url || !created_by) {
      return res.status(400).json({ 
        success: false, 
        message: '请填写所有必填字段'
      })
    }
    
    const [result] = await pool.query(
      'INSERT INTO public_videos (title, participant_a, participant_b, assessment_date, video_url, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, participant_a, participant_b, assessment_date, video_url, description, created_by]
    )
    
    res.json({ success: true, data: { id: result.insertId } })
  } catch (error) {
    console.error('创建公开视频失败:', error)
    res.status(500).json({ success: false, message: '创建公开视频失败' })
  }
})

// 更新公开视频
router.put('/:id', async (req, res) => {
  try {
    const { title, participant_a, participant_b, assessment_date, video_url, description } = req.body
    
    if (!title || !participant_a || !participant_b || !assessment_date || !video_url) {
      return res.status(400).json({ success: false, message: '请填写所有必填字段' })
    }
    
    await pool.query(
      'UPDATE public_videos SET title = ?, participant_a = ?, participant_b = ?, assessment_date = ?, video_url = ?, description = ? WHERE id = ?',
      [title, participant_a, participant_b, assessment_date, video_url, description, req.params.id]
    )
    
    res.json({ success: true, message: '更新成功' })
  } catch (error) {
    console.error('更新公开视频失败:', error)
    res.status(500).json({ success: false, message: '更新公开视频失败' })
  }
})

// 删除公开视频
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM public_videos WHERE id = ?', [req.params.id])
    res.json({ success: true, message: '删除成功' })
  } catch (error) {
    console.error('删除公开视频失败:', error)
    res.status(500).json({ success: false, message: '删除公开视频失败' })
  }
})

// 批量删除公开视频
router.post('/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要删除的视频' })
    }
    
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`DELETE FROM public_videos WHERE id IN (${placeholders})`, ids)
    
    res.json({ success: true, message: '批量删除成功' })
  } catch (error) {
    console.error('批量删除公开视频失败:', error)
    res.status(500).json({ success: false, message: '批量删除公开视频失败' })
  }
})

export default router
