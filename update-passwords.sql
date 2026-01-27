-- 更新管理员密码（密码: admin123）
INSERT INTO admins (username, password, name, email) 
VALUES ('admin', '$2a$10$InLAnAVhnzthqxAf9JN8KuB3rS3X6NcFUkM6UhpPU9nsZZB2IxXvy', '系统管理员', 'admin@ziye.com') 
ON DUPLICATE KEY UPDATE password='$2a$10$InLAnAVhnzthqxAf9JN8KuB3rS3X6NcFUkM6UhpPU9nsZZB2IxXvy';

-- 更新学员密码（密码: student123）
INSERT INTO students (username, password, name, qq, status) 
VALUES ('student', '$2a$10$xksZfbbawytisfjk74wwmO6ONH9v8m68WD.P2iuBxdmkka5kw/MZy', '测试学员', '123456789', 'training') 
ON DUPLICATE KEY UPDATE password='$2a$10$xksZfbbawytisfjk74wwmO6ONH9v8m68WD.P2iuBxdmkka5kw/MZy';
