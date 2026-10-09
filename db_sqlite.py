"""
SQLite 数据库操作模块 - 支持多 Worker 并发
版本: v1.7.6
作者: 枫中数智化研发组

特性:
- WAL 模式支持并发读写
- 自动重试机制处理锁冲突
- 完整的错误处理和日志记录
- 与 JSON 格式 100% 兼容
"""
import sqlite3
import json
import time
import logging
from pathlib import Path
from contextlib import contextmanager
from typing import Optional, List, Dict, Tuple


logger = logging.getLogger(__name__)


class SQLiteDB:
    """SQLite 数据库封装，支持多进程并发"""

    def __init__(self, db_path: str):
        """
        初始化数据库连接

        Args:
            db_path: 数据库文件路径
        """
        self.db_path = db_path
        self._init_database()

    def _init_database(self):
        """初始化数据库，创建表和索引，启用 WAL 模式"""
        # 确保数据库目录存在
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row  # 返回字典形式

        try:
            # 读取并执行 schema.sql
            schema_path = Path(__file__).parent / "schema.sql"
            if schema_path.exists():
                with schema_path.open('r', encoding='utf-8') as f:
                    schema_sql = f.read()
                conn.executescript(schema_sql)
            else:
                # 如果 schema.sql 不存在，使用内嵌的 schema
                self._create_schema(conn)

            conn.commit()
            logger.info(f"[SQLite] Database initialized: {self.db_path}")
        except Exception as e:
            logger.error(f"[SQLite] Failed to initialize database: {e}")
            raise
        finally:
            conn.close()

    def _create_schema(self, conn: sqlite3.Connection):
        """创建数据库 schema (内嵌版本)"""
        # 启用 WAL 模式和性能优化
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA cache_size=20000")  # 增加缓存到20MB
        conn.execute("PRAGMA page_size=8192")    # 增大页大小
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA mmap_size=268435456")  # 启用内存映射（256MB）
        conn.execute("PRAGMA read_uncommitted=1")   # 允许脏读（加速查询）
        conn.execute("PRAGMA foreign_keys=ON")

        # 创建用户表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                nickname TEXT DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        ''')

        # 创建任务表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS todos (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT DEFAULT '',
                completed INTEGER DEFAULT 0,
                pinned INTEGER DEFAULT 0,
                start_at INTEGER,
                repeat_daily INTEGER DEFAULT 0,
                repeat_config TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
        ''')

        # 创建索引（优化查询性能）
        # 复合索引：覆盖user_id + 排序字段
        conn.execute('CREATE INDEX IF NOT EXISTS idx_todos_user_sort ON todos(user_id, pinned DESC, start_at DESC, created_at DESC)')
        # 单独的completed索引（用于统计）
        conn.execute('CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed)')
        # 昵称索引（用于搜索）
        conn.execute('CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)')

        # ============ 协作任务相关表 ============
        # 协作任务表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS collaborative_todos (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT DEFAULT '',
                completed INTEGER DEFAULT 0,
                pinned INTEGER DEFAULT 0,
                start_at INTEGER,
                repeat_daily INTEGER DEFAULT 0,
                repeat_config TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        ''')

        # 协作关系表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS todo_collaborators (
                todo_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                joined_at INTEGER NOT NULL,
                PRIMARY KEY (todo_id, user_id),
                FOREIGN KEY (todo_id) REFERENCES collaborative_todos(id) ON DELETE CASCADE
            )
        ''')

        # 协作附件表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS collaborative_attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                todo_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                file_size INTEGER DEFAULT 0,
                mime_type TEXT DEFAULT '',
                uploaded_by TEXT NOT NULL,
                uploaded_at INTEGER NOT NULL,
                FOREIGN KEY (todo_id) REFERENCES collaborative_todos(id) ON DELETE CASCADE
            )
        ''')

        # 协作任务索引
        conn.execute('CREATE INDEX IF NOT EXISTS idx_collab_todos_updated ON collaborative_todos(updated_at)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_collaborators_user ON todo_collaborators(user_id)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_collab_attachments_todo ON collaborative_attachments(todo_id)')

    @contextmanager
    def get_connection(self, timeout: float = 10.0):
        """
        获取数据库连接（上下文管理器）

        Args:
            timeout: 锁等待超时时间（秒）

        Yields:
            sqlite3.Connection: 数据库连接
        """
        conn = sqlite3.connect(self.db_path, timeout=timeout)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def execute_with_retry(self, query: str, params: tuple = (),
                          max_retries: int = 5, retry_delay: float = 0.05) -> Optional[List]:
        """
        执行 SQL 语句，失败时自动重试（处理数据库锁）

        Args:
            query: SQL 语句
            params: 参数
            max_retries: 最大重试次数
            retry_delay: 初始重试延迟（秒，会指数增长）

        Returns:
            查询结果列表（SELECT）或 None（INSERT/UPDATE/DELETE）

        Raises:
            sqlite3.Error: 重试后仍失败
        """
        for attempt in range(max_retries):
            try:
                with self.get_connection() as conn:
                    cursor = conn.execute(query, params)

                    # 如果是 SELECT 语句，返回结果
                    if query.strip().upper().startswith('SELECT'):
                        return cursor.fetchall()

                    # 如果是 INSERT/UPDATE/DELETE，提交事务
                    conn.commit()
                    return None

            except sqlite3.OperationalError as e:
                if 'database is locked' in str(e).lower() or 'locked' in str(e).lower():
                    if attempt < max_retries - 1:
                        # 指数退避：等待时间逐渐增加
                        wait_time = retry_delay * (2 ** attempt)
                        logger.warning(
                            f"[SQLite] Database locked, retrying in {wait_time:.3f}s "
                            f"(attempt {attempt + 1}/{max_retries})"
                        )
                        time.sleep(wait_time)
                        continue
                logger.error(f"[SQLite] Operational error after {max_retries} retries: {e}")
                raise
            except Exception as e:
                logger.error(f"[SQLite] Query failed: {e}\nQuery: {query}\nParams: {params}")
                raise

        raise sqlite3.OperationalError(f"Failed after {max_retries} retries")

    # ==================== 用户操作 ====================

    def create_user(self, user_id: str, nickname: str = '') -> bool:
        """
        创建用户

        Args:
            user_id: 用户ID
            nickname: 昵称

        Returns:
            True: 创建成功
            False: 用户已存在
        """
        now = int(time.time() * 1000)
        try:
            self.execute_with_retry('''
                INSERT INTO users (user_id, nickname, created_at, updated_at)
                VALUES (?, ?, ?, ?)
            ''', (user_id, nickname, now, now))
            logger.info(f"[SQLite] User created: {user_id}")
            return True
        except sqlite3.IntegrityError:
            logger.debug(f"[SQLite] User already exists: {user_id}")
            return False

    def user_exists(self, user_id: str) -> bool:
        """检查用户是否存在"""
        result = self.execute_with_retry(
            'SELECT 1 FROM users WHERE user_id = ? LIMIT 1',
            (user_id,)
        )
        return len(result) > 0 if result else False

    def get_user_profile(self, user_id: str) -> Optional[Dict]:
        """
        获取用户资料

        Returns:
            用户信息字典，格式与JSON兼容:
            {
                "user_id": "...",
                "nickname": "...",
                "created_at": 1705132800000,
                "updated_at": 1705132800000
            }
        """
        result = self.execute_with_retry(
            'SELECT * FROM users WHERE user_id = ?',
            (user_id,)
        )
        if result and len(result) > 0:
            return dict(result[0])
        return None

    def update_user_nickname(self, user_id: str, nickname: str) -> bool:
        """更新用户昵称"""
        now = int(time.time() * 1000)
        self.execute_with_retry('''
            UPDATE users
            SET nickname = ?, updated_at = ?
            WHERE user_id = ?
        ''', (nickname, now, user_id))
        logger.info(f"[SQLite] User nickname updated: {user_id} -> {nickname}")
        return True

    def get_user(self, user_id: str) -> Optional[Dict]:
        """获取用户信息（别名，兼容性）"""
        return self.get_user_profile(user_id)

    def get_all_users(self) -> List[Dict]:
        """获取所有用户列表"""
        results = self.execute_with_retry(
            'SELECT * FROM users ORDER BY created_at DESC'
        )
        return [dict(row) for row in results] if results else []

    def create_or_update_user(self, user_id: str, nickname: str = '',
                             created_at: Optional[int] = None,
                             updated_at: Optional[int] = None) -> bool:
        """创建或更新用户（用于迁移）"""
        now = int(time.time() * 1000)
        created_at = created_at or now
        updated_at = updated_at or now

        try:
            # 尝试插入
            self.execute_with_retry('''
                INSERT INTO users (user_id, nickname, created_at, updated_at)
                VALUES (?, ?, ?, ?)
            ''', (user_id, nickname, created_at, updated_at))
            logger.debug(f"[SQLite] User created: {user_id}")
        except sqlite3.IntegrityError:
            # 如果存在则更新
            self.execute_with_retry('''
                UPDATE users
                SET nickname = ?, updated_at = ?
                WHERE user_id = ?
            ''', (nickname, updated_at, user_id))
            logger.debug(f"[SQLite] User updated: {user_id}")
        return True

    def search_users(self, query: str = '', limit: int = 50) -> List[Dict]:
        """
        搜索用户（支持昵称和ID模糊匹配）

        Args:
            query: 搜索关键词（空字符串返回所有用户）
            limit: 返回结果数量限制

        Returns:
            用户列表，格式: [{"user_id": "...", "nickname": "..."}, ...]
        """
        if not query:
            # 空查询返回所有用户
            results = self.execute_with_retry(
                'SELECT user_id, nickname FROM users ORDER BY created_at DESC LIMIT ?',
                (limit,)
            )
        else:
            # 模糊搜索
            pattern = f'%{query}%'
            results = self.execute_with_retry('''
                SELECT user_id, nickname FROM users
                WHERE user_id LIKE ? OR nickname LIKE ?
                ORDER BY created_at DESC
                LIMIT ?
            ''', (pattern, pattern, limit))

        return [dict(row) for row in results] if results else []

    def get_all_users_with_stats(self) -> List[Dict]:
        """
        获取所有用户及其任务统计（管理员功能）

        Returns:
            [{
                "user_id": "...",
                "nickname": "...",
                "created_at": 1705132800000,
                "task_count": 10,
                "completed_count": 5
            }, ...]
        """
        results = self.execute_with_retry('''
            SELECT
                u.user_id,
                u.nickname,
                u.created_at,
                COUNT(t.id) as task_count,
                SUM(CASE WHEN t.completed = 1 THEN 1 ELSE 0 END) as completed_count
            FROM users u
            LEFT JOIN todos t ON u.user_id = t.user_id
            GROUP BY u.user_id
            ORDER BY u.created_at DESC
        ''')
        return [dict(row) for row in results] if results else []

    def delete_user(self, user_id: str) -> bool:
        """
        删除用户及其所有任务（事务保证原子性）

        Returns:
            True: 删除成功
        """
        with self.get_connection() as conn:
            conn.execute('BEGIN')
            try:
                # 先删除任务
                conn.execute('DELETE FROM todos WHERE user_id = ?', (user_id,))
                # 再删除用户
                result = conn.execute('DELETE FROM users WHERE user_id = ?', (user_id,))
                conn.commit()
                logger.info(f"[SQLite] User deleted: {user_id}")
                return result.rowcount > 0
            except Exception as e:
                conn.rollback()
                logger.error(f"[SQLite] Delete user failed: {e}")
                raise

    # ==================== 任务操作 ====================

    def get_user_todos(self, user_id: str) -> List[Dict]:
        """
        获取用户所有任务（优化版本）

        Returns:
            任务列表，格式与JSON完全兼容
        """
        # 优化：明确列名，利用复合索引
        results = self.execute_with_retry('''
            SELECT id, title, content, completed, pinned,
                   start_at, repeat_daily, repeat_config,
                   created_at, updated_at
            FROM todos
            WHERE user_id = ?
            ORDER BY pinned DESC, start_at DESC, created_at DESC
        ''', (user_id,))

        if not results:
            return []

        todos = []
        for row in results:
            todo = dict(row)

            # 解析 JSON 字段（优化：只在需要时解析）
            if todo.get('repeat_config'):
                try:
                    todo['repeatConfig'] = json.loads(todo['repeat_config'])
                except (json.JSONDecodeError, TypeError):
                    todo['repeatConfig'] = {'mode': 'none', 'hours': 0}
            else:
                todo['repeatConfig'] = {'mode': 'none', 'hours': 0}

            # 转换字段名和类型（SQLite → JSON格式）
            todo['startAt'] = todo.pop('start_at', None)
            todo['repeatDaily'] = bool(todo.pop('repeat_daily', 0))
            todo['createdAt'] = todo.pop('created_at')
            todo['updatedAt'] = todo.pop('updated_at')
            todo['completed'] = bool(todo['completed'])
            todo['pinned'] = bool(todo['pinned'])

            # 移除内部字段
            todo.pop('repeat_config', None)

            todos.append(todo)

        return todos

    def save_user_todos(self, user_id: str, todos: List[Dict]) -> bool:
        """
        保存用户所有任务（完全替换，保证与JSON行为一致）

        Args:
            user_id: 用户ID
            todos: 任务列表（JSON格式）

        Returns:
            True: 保存成功
        """
        with self.get_connection() as conn:
            conn.execute('BEGIN')
            try:
                # 删除用户所有旧任务
                conn.execute('DELETE FROM todos WHERE user_id = ?', (user_id,))

                # 批量插入新任务
                for todo in todos:
                    # 跳过无效任务
                    if not todo.get('id') or not todo.get('title'):
                        logger.warning(f"[SQLite] Skipping invalid todo: {todo}")
                        continue

                    # 处理 repeatConfig（可能是 repeatConfig 或 repeat_config）
                    repeat_config = todo.get('repeatConfig') or todo.get('repeat_config', {'mode': 'none', 'hours': 0})

                    conn.execute('''
                        INSERT INTO todos (
                            id, user_id, title, content, completed, pinned,
                            start_at, repeat_daily, repeat_config, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        todo['id'],
                        user_id,
                        todo['title'],
                        todo.get('content', ''),
                        1 if todo.get('completed') else 0,
                        1 if todo.get('pinned') else 0,
                        todo.get('startAt') or todo.get('start_at'),
                        1 if todo.get('repeatDaily') or todo.get('repeat_daily') else 0,
                        json.dumps(repeat_config),
                        todo.get('createdAt') or todo.get('created_at'),
                        todo.get('updatedAt') or todo.get('updated_at')
                    ))

                conn.commit()
                logger.debug(f"[SQLite] Saved {len(todos)} todos for user: {user_id}")
                return True
            except Exception as e:
                conn.rollback()
                logger.error(f"[SQLite] Save todos failed for {user_id}: {e}")
                raise

    def add_todo(self, user_id: str, todo: Dict) -> bool:
        """
        添加单个任务

        Args:
            user_id: 用户ID
            todo: 任务对象（JSON格式）

        Returns:
            True: 添加成功
        """
        repeat_config = todo.get('repeatConfig') or todo.get('repeat_config', {'mode': 'none', 'hours': 0})

        self.execute_with_retry('''
            INSERT INTO todos (
                id, user_id, title, content, completed, pinned,
                start_at, repeat_daily, repeat_config, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            todo['id'],
            user_id,
            todo['title'],
            todo.get('content', ''),
            1 if todo.get('completed') else 0,
            1 if todo.get('pinned') else 0,
            todo.get('startAt') or todo.get('start_at'),
            1 if todo.get('repeatDaily') or todo.get('repeat_daily') else 0,
            json.dumps(repeat_config),
            todo.get('createdAt') or todo.get('created_at'),
            todo.get('updatedAt') or todo.get('updated_at')
        ))
        logger.debug(f"[SQLite] Added todo: {todo['id']} for user: {user_id}")
        return True

    def get_todo(self, todo_id: str, user_id: str) -> Optional[Dict]:
        """
        获取指定任务（用于权限验证）

        Args:
            todo_id: 任务ID
            user_id: 用户ID

        Returns:
            任务字典或 None（如果不存在或无权限）
        """
        results = self.execute_with_retry('''
            SELECT id, title, content, completed, pinned,
                   start_at, repeat_daily, repeat_config,
                   created_at, updated_at
            FROM todos
            WHERE id = ? AND user_id = ?
            LIMIT 1
        ''', (todo_id, user_id))

        if not results or len(results) == 0:
            return None

        row = results[0]
        todo = dict(row)

        # 解析 JSON 字段
        if todo.get('repeat_config'):
            try:
                todo['repeatConfig'] = json.loads(todo['repeat_config'])
            except (json.JSONDecodeError, TypeError):
                todo['repeatConfig'] = {'mode': 'none', 'hours': 0}
        else:
            todo['repeatConfig'] = {'mode': 'none', 'hours': 0}

        # 转换字段名和类型
        todo['startAt'] = todo.pop('start_at', None)
        todo['repeatDaily'] = bool(todo.pop('repeat_daily', 0))
        todo['createdAt'] = todo.pop('created_at')
        todo['updatedAt'] = todo.pop('updated_at')
        todo['completed'] = bool(todo['completed'])
        todo['pinned'] = bool(todo['pinned'])

        # 移除内部字段
        todo.pop('repeat_config', None)

        return todo

    # ==================== 导入/导出功能 ====================

    def import_users_from_json(self, profiles: Dict) -> Tuple[int, int]:
        """
        从 JSON 格式导入用户数据

        Args:
            profiles: 用户资料字典 {user_id: {nickname, created_at, updated_at}, ...}

        Returns:
            (导入成功数, 跳过数)
        """
        success_count = 0
        skip_count = 0

        for user_id, profile in profiles.items():
            try:
                if self.create_user(
                    user_id,
                    profile.get('nickname', '')
                ):
                    success_count += 1
                else:
                    skip_count += 1
            except Exception as e:
                logger.error(f"[SQLite] Failed to import user {user_id}: {e}")
                skip_count += 1

        logger.info(f"[SQLite] Imported users: {success_count} success, {skip_count} skipped")
        return success_count, skip_count

    def export_all_data(self) -> Dict:
        """
        导出所有数据为 JSON 格式（用于备份）

        Returns:
            {
                "users": {user_id: {nickname, created_at, updated_at}, ...},
                "todos": {user_id: [todo1, todo2, ...], ...}
            }
        """
        data = {
            "users": {},
            "todos": {}
        }

        # 导出所有用户
        users = self.execute_with_retry('SELECT * FROM users')
        if users:
            for row in users:
                user = dict(row)
                data["users"][user['user_id']] = {
                    "nickname": user['nickname'],
                    "created_at": user['created_at'],
                    "updated_at": user['updated_at']
                }

        # 导出所有任务
        all_todos = self.execute_with_retry('SELECT * FROM todos ORDER BY user_id, created_at')
        if all_todos:
            for row in all_todos:
                todo = dict(row)
                user_id = todo['user_id']

                if user_id not in data["todos"]:
                    data["todos"][user_id] = []

                # 转换为 JSON 格式
                json_todo = {
                    "id": todo['id'],
                    "title": todo['title'],
                    "content": todo['content'],
                    "completed": bool(todo['completed']),
                    "pinned": bool(todo['pinned']),
                    "startAt": todo['start_at'],
                    "repeatDaily": bool(todo['repeat_daily']),
                    "repeatConfig": json.loads(todo['repeat_config']) if todo['repeat_config'] else {'mode': 'none', 'hours': 0},
                    "createdAt": todo['created_at'],
                    "updatedAt": todo['updated_at']
                }
                data["todos"][user_id].append(json_todo)

        return data


    # ==================== 附件管理方法 ====================

    def add_attachment(self, att_data: dict) -> bool:
        """
        添加附件记录

        Args:
            att_data: 附件数据字典，包含 id, todo_id, user_id, filename,
                     stored_filename, file_size, mime_type, file_hash, uploaded_at

        Returns:
            bool: 添加成功返回 True
        """
        query = '''
            INSERT INTO attachments
            (id, todo_id, user_id, filename, stored_filename, file_size,
             mime_type, file_hash, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        '''
        params = (
            att_data['id'],
            att_data['todo_id'],
            att_data['user_id'],
            att_data['filename'],
            att_data['stored_filename'],
            att_data['file_size'],
            att_data.get('mime_type', ''),
            att_data.get('file_hash', ''),
            att_data['uploaded_at']
        )

        try:
            self.execute_with_retry(query, params)
            logger.info(f"[SQLite] Attachment added: {att_data['id']}")
            return True
        except Exception as e:
            logger.error(f"[SQLite] Failed to add attachment: {e}")
            return False

    def get_attachments(self, todo_id: str) -> List[dict]:
        """
        获取任务的所有附件

        Args:
            todo_id: 任务ID

        Returns:
            附件列表
        """
        query = 'SELECT * FROM attachments WHERE todo_id = ? ORDER BY uploaded_at DESC'
        rows = self.execute_with_retry(query, (todo_id,))

        if not rows:
            return []

        return [dict(row) for row in rows]

    def get_attachment(self, att_id: str) -> Optional[dict]:
        """
        获取单个附件信息

        Args:
            att_id: 附件ID

        Returns:
            附件字典或 None
        """
        query = 'SELECT * FROM attachments WHERE id = ?'
        rows = self.execute_with_retry(query, (att_id,))

        if rows and len(rows) > 0:
            return dict(rows[0])
        return None

    def delete_attachment(self, att_id: str) -> bool:
        """
        删除附件记录

        Args:
            att_id: 附件ID

        Returns:
            bool: 删除成功返回 True
        """
        query = 'DELETE FROM attachments WHERE id = ?'

        try:
            self.execute_with_retry(query, (att_id,))
            logger.info(f"[SQLite] Attachment deleted: {att_id}")
            return True
        except Exception as e:
            logger.error(f"[SQLite] Failed to delete attachment: {e}")
            return False

    def get_user_attachments_stats(self, user_id: str) -> dict:
        """
        获取用户附件统计信息

        Args:
            user_id: 用户ID

        Returns:
            字典包含 total_size, file_count
        """
        query = '''
            SELECT
                COALESCE(SUM(file_size), 0) as total_size,
                COUNT(*) as file_count
            FROM attachments
            WHERE user_id = ?
        '''
        rows = self.execute_with_retry(query, (user_id,))

        if rows and len(rows) > 0:
            return {
                'total_size': rows[0]['total_size'],
                'file_count': rows[0]['file_count']
            }
        return {'total_size': 0, 'file_count': 0}

    def update_attachment_quota(self, user_id: str) -> bool:
        """
        更新用户附件配额记录

        Args:
            user_id: 用户ID

        Returns:
            bool: 更新成功返回 True
        """
        stats = self.get_user_attachments_stats(user_id)

        query = '''
            INSERT OR REPLACE INTO attachment_quotas
            (user_id, total_size, file_count, updated_at)
            VALUES (?, ?, ?, ?)
        '''
        params = (
            user_id,
            stats['total_size'],
            stats['file_count'],
            int(time.time() * 1000)
        )

        try:
            self.execute_with_retry(query, params)
            return True
        except Exception as e:
            logger.error(f"[SQLite] Failed to update quota: {e}")
            return False

    def get_attachment_by_hash(self, file_hash: str, user_id: str) -> Optional[dict]:
        """
        根据文件哈希查找用户已上传的相同文件

        Args:
            file_hash: 文件SHA256哈希
            user_id: 用户ID

        Returns:
            附件字典或 None
        """
        query = 'SELECT * FROM attachments WHERE file_hash = ? AND user_id = ? LIMIT 1'
        rows = self.execute_with_retry(query, (file_hash, user_id))

        if rows and len(rows) > 0:
            return dict(rows[0])
        return None

    # ============ 协作任务方法 ============

    def create_collaborative_todo(self, todo_data: dict, user_ids: list) -> str:
        """
        创建协作任务

        Args:
            todo_data: 任务数据
            user_ids: 所有协作者ID列表（包括创建者）

        Returns:
            任务ID
        """
        import json
        import uuid
        now = int(time.time() * 1000)
        # 总是生成新的唯一ID，避免与原任务ID冲突
        todo_id = str(uuid.uuid4())

        with self.get_connection() as conn:
            conn.execute('BEGIN')
            try:
                # 创建协作任务
                conn.execute("""
                    INSERT INTO collaborative_todos
                    (id, title, content, completed, pinned, start_at, repeat_daily, repeat_config, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    todo_id,
                    todo_data.get('title', ''),
                    todo_data.get('content', ''),
                    1 if todo_data.get('completed') else 0,
                    1 if todo_data.get('pinned') else 0,
                    todo_data.get('startAt') or todo_data.get('start_at'),
                    1 if todo_data.get('repeatDaily') or todo_data.get('repeat_daily') else 0,
                    json.dumps(todo_data.get('repeatConfig') or todo_data.get('repeat_config') or {'mode': 'none', 'hours': 0}),
                    todo_data.get('createdAt') or todo_data.get('created_at') or now,
                    now
                ))

                # 添加所有协作者
                for user_id in user_ids:
                    conn.execute("""
                        INSERT OR IGNORE INTO todo_collaborators (todo_id, user_id, joined_at)
                        VALUES (?, ?, ?)
                    """, (todo_id, user_id, now))

                conn.commit()
                logger.info(f"[SQLite] Created collaborative todo {todo_id} with {len(user_ids)} collaborators")
                return todo_id
            except Exception as e:
                conn.rollback()
                logger.error(f"[SQLite] Failed to create collaborative todo: {e}")
                raise

    def get_collaborative_todos(self, user_id: str) -> list:
        """
        获取用户参与的所有协作任务

        Args:
            user_id: 用户ID

        Returns:
            协作任务列表
        """
        import json
        query = """
            SELECT ct.*, GROUP_CONCAT(tc2.user_id) as collaborator_ids
            FROM collaborative_todos ct
            JOIN todo_collaborators tc ON ct.id = tc.todo_id
            LEFT JOIN todo_collaborators tc2 ON ct.id = tc2.todo_id
            WHERE tc.user_id = ?
            GROUP BY ct.id
            ORDER BY ct.pinned DESC, ct.start_at DESC, ct.created_at DESC
        """
        rows = self.execute_with_retry(query, (user_id,))

        if not rows:
            return []

        todos = []
        for row in rows:
            todo = dict(row)
            # 转换字段名为驼峰命名
            todo['id'] = todo['id']
            todo['title'] = todo['title']
            todo['content'] = todo.get('content', '')
            todo['completed'] = bool(todo.get('completed'))
            todo['pinned'] = bool(todo.get('pinned'))
            todo['startAt'] = todo.pop('start_at', None)
            todo['repeatDaily'] = bool(todo.pop('repeat_daily', False))
            try:
                todo['repeatConfig'] = json.loads(todo.pop('repeat_config', '{}') or '{}')
            except:
                todo['repeatConfig'] = {'mode': 'none', 'hours': 0}
            todo['createdAt'] = todo.pop('created_at')
            todo['updatedAt'] = todo.pop('updated_at')
            todo['isCollaborative'] = True

            # 获取协作者列表
            collaborator_ids = (todo.pop('collaborator_ids', '') or '').split(',')
            todo['collaborators'] = self.get_collaborators_info(todo['id'])

            todos.append(todo)

        return todos

    def get_collaborators_info(self, todo_id: str) -> list:
        """
        获取协作任务的所有协作者信息

        Args:
            todo_id: 任务ID

        Returns:
            协作者列表 [{'userId': ..., 'nickname': ...}, ...]
        """
        query = """
            SELECT tc.user_id, u.nickname
            FROM todo_collaborators tc
            LEFT JOIN users u ON tc.user_id = u.user_id
            WHERE tc.todo_id = ?
        """
        rows = self.execute_with_retry(query, (todo_id,))
        if not rows:
            return []
        # 返回下划线命名的字段，与前端保持一致
        return [{'user_id': row['user_id'], 'nickname': row['nickname'] or row['user_id']} for row in rows]

    def is_collaborator(self, todo_id: str, user_id: str) -> bool:
        """检查用户是否为协作任务的协作者"""
        query = "SELECT 1 FROM todo_collaborators WHERE todo_id = ? AND user_id = ?"
        rows = self.execute_with_retry(query, (todo_id, user_id))
        return bool(rows and len(rows) > 0)

    def count_collaborators(self, todo_id: str) -> int:
        """获取协作任务的协作者数量"""
        query = "SELECT COUNT(*) as cnt FROM todo_collaborators WHERE todo_id = ?"
        rows = self.execute_with_retry(query, (todo_id,))
        return rows[0]['cnt'] if rows else 0

    def add_collaborators(self, todo_id: str, user_ids: list) -> list:
        """
        添加协作者

        Args:
            todo_id: 任务ID
            user_ids: 要添加的用户ID列表

        Returns:
            成功添加的用户ID列表
        """
        now = int(time.time() * 1000)
        added = []

        for user_id in user_ids:
            # 检查用户是否存在
            if not self.user_exists(user_id):
                continue
            # 检查是否已是协作者
            if self.is_collaborator(todo_id, user_id):
                continue

            try:
                query = "INSERT INTO todo_collaborators (todo_id, user_id, joined_at) VALUES (?, ?, ?)"
                self.execute_with_retry(query, (todo_id, user_id, now))
                added.append(user_id)
            except Exception as e:
                logger.error(f"[SQLite] Failed to add collaborator {user_id}: {e}")

        return added

    def remove_collaborator(self, todo_id: str, user_id: str) -> dict:
        """
        移除协作者（退出协作）

        Args:
            todo_id: 任务ID
            user_id: 用户ID

        Returns:
            {'status': 'left'} 或 {'status': 'deleted'} 或 {'status': 'converted', 'newTodoId': ...}
        """
        count = self.count_collaborators(todo_id)

        if count > 2:
            # 多人协作（3人及以上）：仅移除自己
            query = "DELETE FROM todo_collaborators WHERE todo_id = ? AND user_id = ?"
            self.execute_with_retry(query, (todo_id, user_id))
            logger.info(f"[SQLite] User {user_id} left collaborative todo {todo_id}")
            return {'status': 'left'}
        elif count == 2:
            # 只剩2人：移除自己后，将任务转为剩下那个人的个人任务
            # 获取另一个协作者
            query = "SELECT user_id FROM todo_collaborators WHERE todo_id = ? AND user_id != ?"
            rows = self.execute_with_retry(query, (todo_id, user_id))
            if rows:
                remaining_user = rows[0]['user_id']
                # 获取协作任务数据
                todo = self.get_collaborative_todo(todo_id)
                if todo:
                    # 创建个人任务
                    import json
                    now = int(time.time() * 1000)
                    new_id = todo_id  # 保持相同ID
                    try:
                        query = """
                            INSERT INTO todos (id, user_id, title, content, completed, pinned,
                                start_at, repeat_daily, repeat_config, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """
                        self.execute_with_retry(query, (
                            new_id,
                            remaining_user,
                            todo.get('title', ''),
                            todo.get('content', ''),
                            1 if todo.get('completed') else 0,
                            1 if todo.get('pinned') else 0,
                            todo.get('startAt') or todo.get('start_at'),
                            1 if todo.get('repeatDaily') or todo.get('repeat_daily') else 0,
                            json.dumps(todo.get('repeatConfig') or todo.get('repeat_config') or {'mode': 'none', 'hours': 0}),
                            todo.get('createdAt') or todo.get('created_at') or now,
                            now
                        ))
                        # 删除协作任务
                        self.delete_collaborative_todo(todo_id)
                        logger.info(f"[SQLite] Converted collaborative todo {todo_id} to personal todo for user {remaining_user}")
                        return {'status': 'converted', 'remainingUser': remaining_user}
                    except Exception as e:
                        logger.error(f"[SQLite] Failed to convert to personal: {e}")
                        # 回退：仅移除自己
                        query = "DELETE FROM todo_collaborators WHERE todo_id = ? AND user_id = ?"
                        self.execute_with_retry(query, (todo_id, user_id))
                        return {'status': 'left'}
            # 如果找不到另一个用户，直接删除
            self.delete_collaborative_todo(todo_id)
            logger.info(f"[SQLite] Deleted collaborative todo {todo_id} (conversion failed)")
            return {'status': 'deleted'}
        else:
            # 最后一人（count == 1）：删除整个任务
            self.delete_collaborative_todo(todo_id)
            logger.info(f"[SQLite] Deleted collaborative todo {todo_id} (last collaborator)")
            return {'status': 'deleted'}

    def delete_collaborative_todo(self, todo_id: str) -> bool:
        """
        删除协作任务（包括协作关系和附件记录）

        Args:
            todo_id: 任务ID

        Returns:
            是否成功
        """
        try:
            # 外键级联会自动删除 todo_collaborators 和 collaborative_attachments
            query = "DELETE FROM collaborative_todos WHERE id = ?"
            self.execute_with_retry(query, (todo_id,))
            return True
        except Exception as e:
            logger.error(f"[SQLite] Failed to delete collaborative todo {todo_id}: {e}")
            return False

    def update_collaborative_todo(self, todo_id: str, todo_data: dict) -> bool:
        """
        更新协作任务

        Args:
            todo_id: 任务ID
            todo_data: 任务数据

        Returns:
            是否成功
        """
        import json
        now = int(time.time() * 1000)

        try:
            query = """
                UPDATE collaborative_todos SET
                    title = ?, content = ?, completed = ?, pinned = ?,
                    start_at = ?, repeat_daily = ?, repeat_config = ?, updated_at = ?
                WHERE id = ?
            """
            self.execute_with_retry(query, (
                todo_data.get('title', ''),
                todo_data.get('content', ''),
                1 if todo_data.get('completed') else 0,
                1 if todo_data.get('pinned') else 0,
                todo_data.get('startAt') or todo_data.get('start_at'),
                1 if todo_data.get('repeatDaily') or todo_data.get('repeat_daily') else 0,
                json.dumps(todo_data.get('repeatConfig') or todo_data.get('repeat_config') or {'mode': 'none', 'hours': 0}),
                now,
                todo_id
            ))
            return True
        except Exception as e:
            logger.error(f"[SQLite] Failed to update collaborative todo {todo_id}: {e}")
            return False

    def get_collaborative_todo(self, todo_id: str) -> Optional[dict]:
        """获取单个协作任务"""
        import json
        query = "SELECT * FROM collaborative_todos WHERE id = ?"
        rows = self.execute_with_retry(query, (todo_id,))

        if not rows:
            return None

        row = rows[0]
        todo = dict(row)
        todo['completed'] = bool(todo.get('completed'))
        todo['pinned'] = bool(todo.get('pinned'))
        todo['startAt'] = todo.pop('start_at', None)
        todo['repeatDaily'] = bool(todo.pop('repeat_daily', False))
        try:
            todo['repeatConfig'] = json.loads(todo.pop('repeat_config', '{}') or '{}')
        except:
            todo['repeatConfig'] = {'mode': 'none', 'hours': 0}
        todo['createdAt'] = todo.pop('created_at')
        todo['updatedAt'] = todo.pop('updated_at')
        todo['isCollaborative'] = True
        todo['collaborators'] = self.get_collaborators_info(todo_id)

        return todo

    def convert_to_collaborative(self, user_id: str, todo_id: str, collaborator_ids: list) -> Optional[str]:
        """
        将个人任务转换为协作任务

        Args:
            user_id: 当前用户ID
            todo_id: 原任务ID
            collaborator_ids: 要邀请的协作者ID列表

        Returns:
            新的协作任务ID，失败返回None
        """
        # 获取原任务
        todo = self.get_todo(todo_id, user_id)
        if not todo:
            return None

        # 所有协作者 = 当前用户 + 邀请的协作者
        all_users = [user_id] + [uid for uid in collaborator_ids if uid != user_id]

        # 创建协作任务
        new_todo_id = self.create_collaborative_todo(todo, all_users)

        # 删除原个人任务
        self.delete_todo(todo_id, user_id)

        return new_todo_id

    def delete_todo(self, todo_id: str, user_id: str) -> bool:
        """删除个人任务"""
        try:
            query = "DELETE FROM todos WHERE id = ? AND user_id = ?"
            self.execute_with_retry(query, (todo_id, user_id))
            return True
        except Exception as e:
            logger.error(f"[SQLite] Failed to delete todo {todo_id}: {e}")
            return False
