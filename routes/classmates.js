import express from 'express'
import { pool } from '../config/database.js'
import { authenticateRequest } from '../utils/authGate.js'

const router = express.Router()

// 阶段流程定义（与前端保持一致）
const STAGE_FLOW = [
  '未新训',
  '新训初期',
  '新训一期',
  '新训二期',
  '新训三期',
  '新训准考',
  '紫夜',
  '紫夜尖兵'
]

// 获取同期学员、大一期和小一期学员
router.get('/my-classmates/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params
    const auth = await authenticateRequest(req, { requireType: 'student' })
    if (!auth) {
      return res.status(401).json({ success: false, message: '未登录或会话已失效，请重新登录' })
    }
    if (Number(auth.userId) !== Number(memberId)) {
      return res.status(403).json({ success: false, message: '只能查看自己的同期学员' })
    }
    
    // 获取当前学员信息
    const [currentMember] = await pool.query(
      'SELECT id, nickname, qq, avatar, stage_role FROM members WHERE id = ?',
      [memberId]
    )
    
    if (currentMember.length === 0) {
      return res.status(404).json({
        success: false,
        message: '成员不存在'
      })
    }
    
    const currentStage = currentMember[0].stage_role
    const currentIndex = STAGE_FLOW.indexOf(currentStage)
    
    // 计算大一期和小一期的阶段
    // 大一期 = 更高级的阶段（索引更大）
    // 小一期 = 更低级的阶段（索引更小）
    const seniorStage = currentIndex >= 0 && currentIndex < STAGE_FLOW.length - 1 ? STAGE_FLOW[currentIndex + 1] : null
    const juniorStage = currentIndex > 0 ? STAGE_FLOW[currentIndex - 1] : null
    
    // 获取同期学员（相同阶段，排除自己，只显示正常状态）
    const [sameStage] = await pool.query(`
      SELECT 
        id,
        nickname,
        qq,
        avatar,
        stage_role,
        join_date,
        last_training_date
      FROM members
      WHERE stage_role = ? AND id != ? AND status = '正常'
      ORDER BY join_date
    `, [currentStage, memberId])
    
    // 获取大一期学员（更高级阶段，只显示正常状态）
    let seniorMembers = []
    if (seniorStage) {
      const [seniors] = await pool.query(`
        SELECT 
          id,
          nickname,
          qq,
          avatar,
          stage_role,
          join_date,
          last_training_date
        FROM members
        WHERE stage_role = ? AND status = '正常'
        ORDER BY join_date
      `, [seniorStage])
      seniorMembers = seniors
    }
    
    // 获取小一期学员（更低级阶段，只显示正常状态）
    let juniorMembers = []
    if (juniorStage) {
      const [juniors] = await pool.query(`
        SELECT 
          id,
          nickname,
          qq,
          avatar,
          stage_role,
          join_date,
          last_training_date
        FROM members
        WHERE stage_role = ? AND status = '正常'
        ORDER BY join_date
      `, [juniorStage])
      juniorMembers = juniors
    }
    
    res.json({
      success: true,
      data: {
        currentMember: currentMember[0],
        sameStage: {
          stage: currentStage,
          members: sameStage
        },
        seniorStage: {
          stage: seniorStage,
          members: seniorMembers
        },
        juniorStage: {
          stage: juniorStage,
          members: juniorMembers
        }
      }
    })
  } catch (error) {
    console.error('获取同期学员失败:', error)
    res.status(500).json({
      success: false,
      message: '获取同期学员失败'
    })
  }
})

export default router
