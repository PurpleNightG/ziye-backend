import express from 'express'
import { pool } from '../config/database.js'
import { authenticateRequest } from '../utils/authGate.js'

const router = express.Router()

function parseDeductionRecords(raw) {
  if (!raw) return []
  try {
    if (typeof raw === 'string' && raw.trim() !== '') {
      return JSON.parse(raw)
    }
    if (Array.isArray(raw)) return raw
  } catch (e) {
    console.warn('解析deduction_records失败:', e.message)
  }
  return []
}

function formatAssessmentRow(row) {
  if (!row || !row.assessment_id) return null
  return {
    id: row.assessment_id,
    member_id: row.a_member_id,
    member_name: row.a_member_name,
    avatar: row.a_member_avatar || null,
    qq: row.a_member_qq || null,
    assessment_date: row.a_assessment_date,
    status: row.a_status,
    map: row.a_map,
    custom_map: row.a_custom_map,
    evaluation: row.a_evaluation,
    deduction_records: parseDeductionRecords(row.a_deduction_records),
    total_score: parseFloat(row.a_total_score) || 0,
    rating: row.a_rating,
    has_evaluation: !!row.a_has_evaluation,
    has_deduction_records: !!row.a_has_deduction_records,
    video_url: row.a_video_url,
    has_video: !!row.a_has_video,
    created_at: row.a_created_at,
  }
}

function formatPublicVideoRow(row) {
  const { assessment_id, a_member_id, a_member_name, a_assessment_date, a_status, a_map, a_custom_map,
    a_evaluation, a_deduction_records, a_total_score, a_rating, a_has_evaluation, a_has_deduction_records,
    a_video_url, a_has_video, a_created_at, ...rest } = row

  return {
    ...rest,
    assessment_id: assessment_id || null,
    assessment: formatAssessmentRow(row),
  }
}

const PUBLIC_VIDEO_SELECT = `
  SELECT 
    pv.*,
    m.nickname as creator_name,
    a.id as assessment_id,
    a.member_id as a_member_id,
    a.member_name as a_member_name,
    am.avatar as a_member_avatar,
    am.qq as a_member_qq,
    a.assessment_date as a_assessment_date,
    a.status as a_status,
    a.map as a_map,
    a.custom_map as a_custom_map,
    a.evaluation as a_evaluation,
    a.deduction_records as a_deduction_records,
    a.total_score as a_total_score,
    a.rating as a_rating,
    a.has_evaluation as a_has_evaluation,
    a.has_deduction_records as a_has_deduction_records,
    a.video_url as a_video_url,
    a.has_video as a_has_video,
    a.created_at as a_created_at
  FROM public_videos pv
  LEFT JOIN members m ON pv.created_by = m.id
  LEFT JOIN assessments a ON pv.assessment_id = a.id
  LEFT JOIN members am ON a.member_id = am.id
`

// 获取所有公开视频
router.get('/', async (req, res) => {
  try {
    const [videos] = await pool.query(`${PUBLIC_VIDEO_SELECT} ORDER BY pv.created_at DESC`)
    res.json({ success: true, data: videos.map(formatPublicVideoRow) })
  } catch (error) {
    console.error('获取公开视频失败:', error)
    res.status(500).json({ success: false, message: '获取公开视频失败' })
  }
})

// 获取单个公开视频
router.get('/:id', async (req, res) => {
  try {
    const [videos] = await pool.query(`${PUBLIC_VIDEO_SELECT} WHERE pv.id = ?`, [req.params.id])
    
    if (videos.length === 0) {
      return res.status(404).json({ success: false, message: '视频不存在' })
    }
    
    res.json({ success: true, data: formatPublicVideoRow(videos[0]) })
  } catch (error) {
    console.error('获取公开视频失败:', error)
    res.status(500).json({ success: false, message: '获取公开视频失败' })
  }
})

// 创建公开视频/报告
router.post('/', async (req, res) => {
  try {
    const studentAuth = await authenticateRequest(req, { requireType: 'student' })
    const adminAuth = studentAuth
      ? null
      : await authenticateRequest(req, { requireType: 'admin' })
    if (!studentAuth && !adminAuth) {
      return res.status(401).json({ success: false, message: '未登录或会话已失效，请重新登录' })
    }

    let { title, participant_a, participant_b, assessment_date, video_url, description, created_by, assessment_id } = req.body

    // 学员只能公开自己的考核报告，created_by 强制为本人
    if (studentAuth) {
      if (!assessment_id) {
        return res.status(403).json({ success: false, message: '学员仅可公开自己的考核报告' })
      }
      created_by = studentAuth.userId
    }
    
    if (!created_by) {
      return res.status(400).json({ success: false, message: '缺少创建者信息' })
    }

    let insertData = {
      title,
      participant_a: participant_a || '—',
      participant_b: participant_b || '—',
      assessment_date: assessment_date || new Date().toISOString().split('T')[0],
      video_url: video_url || '',
      description: description || null,
      created_by,
      assessment_id: assessment_id || null,
    }

    if (assessment_id) {
      const [assessments] = await pool.query(
        'SELECT * FROM assessments WHERE id = ? AND member_id = ?',
        [assessment_id, created_by]
      )

      if (assessments.length === 0) {
        return res.status(403).json({ success: false, message: '无权公开该考核报告' })
      }

      const [existing] = await pool.query(
        'SELECT id FROM public_videos WHERE assessment_id = ?',
        [assessment_id]
      )

      if (existing.length > 0) {
        return res.status(400).json({ success: false, message: '该考核报告已公开' })
      }

      const assessment = assessments[0]
      insertData = {
        title: title || `${assessment.member_name}的${assessment.custom_map || assessment.map}考核报告`,
        participant_a: assessment.member_name,
        participant_b: participant_b || '—',
        assessment_date: assessment.assessment_date,
        video_url: assessment.video_url || '',
        description: description || null,
        created_by,
        assessment_id,
      }
    } else if (!title || !video_url || !participant_a || !participant_b) {
      return res.status(400).json({ success: false, message: '请填写所有必填字段' })
    }
    
    const [result] = await pool.query(
      'INSERT INTO public_videos (title, participant_a, participant_b, assessment_date, video_url, description, created_by, assessment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        insertData.title,
        insertData.participant_a,
        insertData.participant_b,
        insertData.assessment_date,
        insertData.video_url,
        insertData.description,
        insertData.created_by,
        insertData.assessment_id,
      ]
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
    
    if (!title || !video_url || !participant_a || !participant_b) {
      return res.status(400).json({ success: false, message: '请填写所有必填字段' })
    }

    const today = new Date().toISOString().split('T')[0]
    
    await pool.query(
      'UPDATE public_videos SET title = ?, participant_a = ?, participant_b = ?, assessment_date = ?, video_url = ?, description = ? WHERE id = ?',
      [
        title,
        participant_a,
        participant_b,
        assessment_date || today,
        video_url,
        description || null,
        req.params.id
      ]
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
