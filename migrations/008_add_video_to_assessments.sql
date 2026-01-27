-- 为考核记录表添加视频字段
ALTER TABLE assessments 
ADD COLUMN video_url VARCHAR(500) DEFAULT NULL COMMENT '考核视频链接（Abyss短链）',
ADD COLUMN video_iframe TEXT DEFAULT NULL COMMENT '考核视频iframe代码',
ADD COLUMN has_video BOOLEAN DEFAULT FALSE COMMENT '是否已上传视频';
