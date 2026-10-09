-- Sofia 记事清单 SQLite 数据库结构
-- 版本: v1.7.6
-- 创建日期: 2025-01-13

-- ==================== 用户表 ====================
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,           -- 用户ID (8-64位字母数字)
    nickname TEXT DEFAULT '',           -- 昵称 (最多32字符)
    created_at INTEGER NOT NULL,        -- 创建时间 (毫秒时间戳)
    updated_at INTEGER NOT NULL         -- 更新时间 (毫秒时间戳)
);

-- 用户表索引
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

-- ==================== 任务表 ====================
CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,                -- 任务ID (UUID)
    user_id TEXT NOT NULL,              -- 所属用户ID
    title TEXT NOT NULL,                -- 任务标题
    content TEXT DEFAULT '',            -- 任务内容 (支持Markdown)
    completed INTEGER DEFAULT 0,        -- 是否完成 (0=未完成, 1=已完成)
    pinned INTEGER DEFAULT 0,           -- 是否置顶 (0=否, 1=是)
    start_at INTEGER,                   -- 开始时间 (毫秒时间戳)
    repeat_daily INTEGER DEFAULT 0,     -- 是否每日重复 (0=否, 1=是)
    repeat_config TEXT,                 -- 重复配置 (JSON字符串)
    created_at INTEGER NOT NULL,        -- 创建时间 (毫秒时间戳)
    updated_at INTEGER NOT NULL,        -- 更新时间 (毫秒时间戳)

    -- 外键约束
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 任务表索引
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
CREATE INDEX IF NOT EXISTS idx_todos_pinned ON todos(pinned);
CREATE INDEX IF NOT EXISTS idx_todos_start ON todos(start_at DESC);
CREATE INDEX IF NOT EXISTS idx_todos_created ON todos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_todos_user_completed ON todos(user_id, completed);

-- ==================== 性能优化配置 ====================
-- 启用 WAL 模式 (Write-Ahead Logging)
-- 优势: 允许读写并发，大幅提升多进程性能
PRAGMA journal_mode=WAL;

-- 同步模式: NORMAL (平衡性能和安全)
-- FULL: 最安全但最慢
-- NORMAL: 平衡选择
-- OFF: 最快但可能丢数据
PRAGMA synchronous=NORMAL;

-- 缓存大小: 10000页 (约40MB)
PRAGMA cache_size=10000;

-- 临时表存储在内存中
PRAGMA temp_store=MEMORY;

-- 自动清理
PRAGMA auto_vacuum=INCREMENTAL;

-- ==================== 数据完整性检查 ====================
-- 启用外键约束
PRAGMA foreign_keys=ON;

-- ==================== 版本信息表 ====================
CREATE TABLE IF NOT EXISTS schema_version (
    version TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES ('1.7.6', strftime('%s', 'now') * 1000, 'Initial SQLite migration from JSON');

-- ==================== 迁移状态表 ====================
CREATE TABLE IF NOT EXISTS migration_status (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
);

-- 记录迁移状态
INSERT OR IGNORE INTO migration_status (key, value, updated_at)
VALUES ('migration_mode', 'json_only', strftime('%s', 'now') * 1000);

-- migration_mode 可能的值:
-- 'json_only': 仅使用JSON (初始状态)
-- 'dual_write': 双写模式 (JSON + SQLite)
-- 'sqlite_primary': SQLite优先读，JSON备份
-- 'sqlite_only': 仅使用SQLite (迁移完成)

-- ==================== 协作任务表 ====================
CREATE TABLE IF NOT EXISTS collaborative_todos (
    id TEXT PRIMARY KEY,                -- 协作任务ID (UUID)
    title TEXT NOT NULL,                -- 任务标题
    content TEXT DEFAULT '',            -- 任务内容 (支持Markdown)
    completed INTEGER DEFAULT 0,        -- 是否完成 (0=未完成, 1=已完成)
    pinned INTEGER DEFAULT 0,           -- 是否置顶 (0=否, 1=是)
    start_at INTEGER,                   -- 开始时间 (毫秒时间戳)
    repeat_daily INTEGER DEFAULT 0,     -- 是否每日重复 (0=否, 1=是)
    repeat_config TEXT,                 -- 重复配置 (JSON字符串)
    created_at INTEGER NOT NULL,        -- 创建时间 (毫秒时间戳)
    updated_at INTEGER NOT NULL         -- 更新时间 (毫秒时间戳)
);

-- ==================== 协作关系表 ====================
CREATE TABLE IF NOT EXISTS todo_collaborators (
    todo_id TEXT NOT NULL,              -- 协作任务ID
    user_id TEXT NOT NULL,              -- 协作者用户ID
    joined_at INTEGER NOT NULL,         -- 加入时间 (毫秒时间戳)
    PRIMARY KEY (todo_id, user_id),
    FOREIGN KEY (todo_id) REFERENCES collaborative_todos(id) ON DELETE CASCADE
);

-- ==================== 协作附件表 ====================
CREATE TABLE IF NOT EXISTS collaborative_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id TEXT NOT NULL,              -- 协作任务ID
    filename TEXT NOT NULL,             -- 存储文件名
    original_filename TEXT NOT NULL,    -- 原始文件名
    file_size INTEGER DEFAULT 0,        -- 文件大小 (字节)
    mime_type TEXT DEFAULT '',          -- MIME类型
    uploaded_by TEXT NOT NULL,          -- 上传者用户ID
    uploaded_at INTEGER NOT NULL,       -- 上传时间 (毫秒时间戳)
    FOREIGN KEY (todo_id) REFERENCES collaborative_todos(id) ON DELETE CASCADE
);

-- 协作任务索引
CREATE INDEX IF NOT EXISTS idx_collab_todos_updated ON collaborative_todos(updated_at);
CREATE INDEX IF NOT EXISTS idx_collaborators_user ON todo_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_collaborators_todo ON todo_collaborators(todo_id);
CREATE INDEX IF NOT EXISTS idx_collab_attachments_todo ON collaborative_attachments(todo_id);

-- 更新版本信息
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES ('2.4.0', strftime('%s', 'now') * 1000, 'Add collaborative todos support');
