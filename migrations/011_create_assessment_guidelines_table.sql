-- 创建考核须知表
CREATE TABLE IF NOT EXISTS assessment_guidelines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  content TEXT NOT NULL COMMENT '须知内容',
  updated_by VARCHAR(100) DEFAULT NULL COMMENT '更新人',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='考核须知表';

-- 插入默认须知内容
INSERT INTO assessment_guidelines (content, updated_by) VALUES 
('# 考核须知

## 考核前准备
1. 请提前15分钟到达指定位置
2. 确保游戏设备正常运行
3. 检查语音通讯是否畅通

## 考核纪律
1. 考核过程中严格遵守战术纪律
2. 服从指挥，认真执行命令
3. 禁止使用任何外挂或作弊手段

## 评分标准
- OODA和基本地形处理
- 危险点处理方式与枪线管理
- 协同配合能力

## 注意事项
1. 考核过程将全程录像
2. 考核结果将在3个工作日内公布
3. 如有疑问请及时联系教官

祝各位考生取得优异成绩！', 
'系统');
