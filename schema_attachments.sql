-- Sofia 记事清单 - 附件功能数据库扩展
-- 版本: v1.10.0
-- 创建日期: 2025-01-18

-- ==================== 附件表 ====================
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,                    -- 附件ID (att_开头的UUID)
    todo_id TEXT NOT NULL,                  -- 所属任务ID
    user_id TEXT NOT NULL,                  -- 上传者用户ID
    filename TEXT NOT NULL,                 -- 原始文件名
    stored_filename TEXT NOT NULL,          -- 存储文件名（UUID + 扩展名）
    file_size INTEGER NOT NULL,             -- 文件大小（字节）
    mime_type TEXT,                         -- MIME类型 (image/png, application/pdf等)
    file_hash TEXT,                         -- 文件SHA256哈希（用于去重和完整性校验）
    uploaded_at INTEGER NOT NULL,           -- 上传时间（毫秒时间戳）

    -- 外键约束
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 附件表索引
CREATE INDEX IF NOT EXISTS idx_attachments_todo ON attachments(todo_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(file_hash);
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded ON attachments(uploaded_at DESC);

-- ==================== 用户附件配额表 ====================
CREATE TABLE IF NOT EXISTS attachment_quotas (
    user_id TEXT PRIMARY KEY,               -- 用户ID
    total_size INTEGER DEFAULT 0,           -- 总使用空间（字节）
    file_count INTEGER DEFAULT 0,           -- 文件总数
    updated_at INTEGER NOT NULL,            -- 更新时间

    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- ==================== 版本信息更新 ====================
INSERT OR REPLACE INTO schema_version (version, applied_at, description)
VALUES ('1.10.0', strftime('%s', 'now') * 1000, 'Add attachments feature');
