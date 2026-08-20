-- 公开视频关联考核报告
ALTER TABLE public_videos
ADD COLUMN assessment_id INT NULL COMMENT '关联考核报告ID' AFTER created_by;

ALTER TABLE public_videos
ADD UNIQUE INDEX idx_public_videos_assessment_id (assessment_id);

ALTER TABLE public_videos
ADD CONSTRAINT fk_public_videos_assessment
FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE SET NULL;
