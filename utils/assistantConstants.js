/** 紫夜助教相关常量 */

export const ASSISTANT_ROLE = '紫夜助教'

/** 新训阶段花名册（不含紫夜及以上、不含干部/助教） */
export const TRAINING_ROSTER_STAGES = [
  '未新训',
  '新训初期',
  '新训一期',
  '新训二期',
  '新训三期',
  '新训准考',
]

/** 助教可直接修改的阶段（一期及以下） */
export const DIRECT_STAGE_ALLOWED = new Set(['未新训', '新训初期', '新训一期'])

/** 需要管理审批的升阶目标 */
export function needsStageApproval(toStage) {
  return !DIRECT_STAGE_ALLOWED.has(toStage)
}

/** 是否具备紫夜助教身份（与 stage_role 解耦，可与尖兵等并存） */
export function isZiyeAssistantMember(member) {
  if (!member) return false
  return !!(Number(member.is_ziye_assistant) === 1 || member.stage_role === ASSISTANT_ROLE)
}

export const DEFAULT_ASSISTANT_PERMISSIONS = {
  view_training_roster: true,
  request_student: true,
  manage_assigned_progress: true,
  propose_stage_promotion: true,
  propose_member_create: true,
  propose_member_edit: true,
  propose_black_point: true,
  propose_leave: true,
  view_assigned_attendance: true,
  propose_quit: true,
  screen_share_assistant: false,
}

export function mergePermissions(raw) {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = {}
    }
  }
  return { ...DEFAULT_ASSISTANT_PERMISSIONS, ...(parsed || {}) }
}
