/**
 * 根据课程进度推算阶段（与管理端 /members/sync-stage 规则一致）
 * @param {{ id: number, code: string }[]} courses
 * @param {{ course_id: number, progress: number }[]} progressRows
 * @returns {string | null} null 表示尚无进度、不调整
 */
export function computeStageFromCourseProgress(courses, progressRows) {
  const courseParts = {
    1: courses.filter((c) => c.code.startsWith('1.')),
    2: courses.filter((c) => c.code.startsWith('2.')),
    3: courses.filter((c) => c.code.startsWith('3.')),
    4: courses.filter((c) => c.code.startsWith('4.')),
  }

  const progress = (progressRows || []).filter((p) => p.progress > 0)
  if (progress.length === 0) return null

  let newStage = '新训初期'

  const partDone = (part) =>
    courseParts[part].length > 0 &&
    courseParts[part].every((course) => {
      const row = progress.find((p) => p.course_id === course.id)
      return row && row.progress === 100
    })

  if (partDone(1)) {
    newStage = '新训一期'
    if (partDone(2)) {
      newStage = '新训二期'
      if (partDone(3)) {
        newStage = '新训三期'
      }
    }
  }

  return newStage
}

/** 管理端 / 助教同步时跳过的特殊阶段（不自动改） */
export const STAGE_SYNC_SKIP_ROLES = [
  '新训准考',
  '紫夜',
  '紫夜尖兵',
  '紫夜助教',
  '会长',
  '执行官',
  '人事',
  '总教',
  '尖兵教官',
  '教官',
  '工程师',
]
