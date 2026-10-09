"""
附件引用系统数据库访问层
版本: v2.1.0
作者: 枫中数智化研发组

设计理念:
1. 物理文件去重 (基于SHA256)
2. 引用计数自动管理
3. 所有权明确
4. 优雅的删除机制
"""
import sqlite3
import time
import logging
import uuid
from pathlib import Path
from contextlib import contextmanager
from typing import Optional, List, Dict, Tuple

logger = logging.getLogger(__name__)


class AttachmentDB:
    """附件引用系统数据库封装"""

    def __init__(self, db_path: str):
        """
        初始化附件数据库连接

        Args:
            db_path: 本机 SQLite 数据库文件路径
        """
        self.db_path = db_path
        self._ensure_initialized()

    def _ensure_initialized(self):
        """确保数据库已初始化"""
        if not Path(self.db_path).exists():
            logger.warning(f"[AttachmentDB] Database not found, will be created: {self.db_path}")

    @contextmanager
    def get_connection(self, timeout: float = 10.0):
        """获取数据库连接（上下文管理器）"""
        conn = sqlite3.connect(self.db_path, timeout=timeout)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def execute_with_retry(self, query: str, params: tuple = (),
                          max_retries: int = 5, retry_delay: float = 0.05) -> Optional[List]:
        """执行 SQL 语句，失败时自动重试（处理数据库锁）"""
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
                        wait_time = retry_delay * (2 ** attempt)
                        logger.warning(
                            f"[AttachmentDB] Database locked, retrying in {wait_time:.3f}s "
                            f"(attempt {attempt + 1}/{max_retries})"
                        )
                        time.sleep(wait_time)
                        continue
                logger.error(f"[AttachmentDB] Operational error after {max_retries} retries: {e}")
                raise
            except Exception as e:
                logger.error(f"[AttachmentDB] Query failed: {e}\\nQuery: {query}\\nParams: {params}")
                raise

        raise sqlite3.OperationalError(f"Failed after {max_retries} retries")

    # ==================== 物理文件操作 ====================

    def add_file(self, file_data: Dict) -> bool:
        """
        添加物理文件记录

        Args:
            file_data: {
                'file_id': str,
                'file_hash': str,
                'stored_filename': str,
                'file_size': int,
                'mime_type': str,
                'created_by': str
            }

        Returns:
            True: 添加成功
        """
        now = int(time.time() * 1000)
        try:
            self.execute_with_retry('''
                INSERT INTO attachment_files
                (file_id, file_hash, stored_filename, file_size, mime_type,
                 reference_count, created_at, created_by, is_orphaned, orphaned_at)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, NULL)
            ''', (
                file_data['file_id'],
                file_data['file_hash'],
                file_data['stored_filename'],
                file_data['file_size'],
                file_data['mime_type'],
                now,
                file_data['created_by']
            ))
            logger.info(f"[AttachmentDB] File added: {file_data['file_id']}")
            return True
        except Exception as e:
            logger.error(f"[AttachmentDB] Failed to add file: {e}")
            return False

    def get_file_by_hash(self, file_hash: str) -> Optional[Dict]:
        """
        根据哈希查找物理文件（用于去重）

        Returns:
            文件字典或 None
        """
        results = self.execute_with_retry(
            'SELECT * FROM attachment_files WHERE file_hash = ? LIMIT 1',
            (file_hash,)
        )
        if results and len(results) > 0:
            return dict(results[0])
        return None

    def get_file(self, file_id: str) -> Optional[Dict]:
        """获取物理文件信息"""
        results = self.execute_with_retry(
            'SELECT * FROM attachment_files WHERE file_id = ?',
            (file_id,)
        )
        if results and len(results) > 0:
            return dict(results[0])
        return None

    def delete_file(self, file_id: str, deleted_by: str, reason: str = 'orphaned') -> bool:
        """
        删除物理文件（记录删除日志）

        Args:
            file_id: 文件ID
            deleted_by: 删除者user_id
            reason: 删除原因 (orphaned/manual/cascade)

        Returns:
            True: 删除成功
        """
        with self.get_connection() as conn:
            conn.execute('BEGIN')
            try:
                # 获取文件信息
                cursor = conn.execute('SELECT * FROM attachment_files WHERE file_id = ?', (file_id,))
                file_info = cursor.fetchone()

                if not file_info:
                    logger.warning(f"[AttachmentDB] File not found: {file_id}")
                    return False

                # 记录删除日志
                log_id = f"log_{uuid.uuid4().hex[:12]}"
                conn.execute('''
                    INSERT INTO deletion_log
                    (log_id, file_id, file_hash, stored_filename, file_size,
                     deleted_by, deletion_reason, deleted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    log_id,
                    file_info['file_id'],
                    file_info['file_hash'],
                    file_info['stored_filename'],
                    file_info['file_size'],
                    deleted_by,
                    reason,
                    int(time.time() * 1000)
                ))

                # 删除文件记录
                conn.execute('DELETE FROM attachment_files WHERE file_id = ?', (file_id,))
                conn.commit()

                logger.info(f"[AttachmentDB] File deleted: {file_id}, reason: {reason}")
                return True
            except Exception as e:
                conn.rollback()
                logger.error(f"[AttachmentDB] Delete file failed: {e}")
                raise

    # ==================== 引用操作 ====================

    def add_reference(self, ref_data: Dict) -> bool:
        """
        添加引用记录（触发器会自动更新引用计数）

        Args:
            ref_data: {
                'ref_id': str,
                'file_id': str,
                'todo_id': str,
                'user_id': str,
                'display_filename': str,
                'is_owner': bool,
                'source_ref_id': Optional[str]
            }

        Returns:
            True: 添加成功
        """
        now = int(time.time() * 1000)
        try:
            self.execute_with_retry('''
                INSERT INTO attachment_references
                (ref_id, file_id, todo_id, user_id, display_filename,
                 is_owner, source_ref_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                ref_data['ref_id'],
                ref_data['file_id'],
                ref_data['todo_id'],
                ref_data['user_id'],
                ref_data['display_filename'],
                1 if ref_data['is_owner'] else 0,
                ref_data.get('source_ref_id'),
                now
            ))
            logger.info(f"[AttachmentDB] Reference added: {ref_data['ref_id']}")
            return True
        except Exception as e:
            logger.error(f"[AttachmentDB] Failed to add reference: {e}")
            return False

    def get_references_by_todo(self, todo_id: str) -> List[Dict]:
        """获取任务的所有附件引用"""
        results = self.execute_with_retry(
            'SELECT * FROM attachment_references WHERE todo_id = ? ORDER BY created_at DESC',
            (todo_id,)
        )
        return [dict(row) for row in results] if results else []

    def get_reference(self, ref_id: str) -> Optional[Dict]:
        """获取单个引用信息"""
        results = self.execute_with_retry(
            'SELECT * FROM attachment_references WHERE ref_id = ?',
            (ref_id,)
        )
        if results and len(results) > 0:
            return dict(results[0])
        return None

    def delete_reference(self, ref_id: str) -> bool:
        """
        删除引用（触发器会自动更新引用计数和孤立状态）

        Returns:
            True: 删除成功
        """
        try:
            self.execute_with_retry(
                'DELETE FROM attachment_references WHERE ref_id = ?',
                (ref_id,)
            )
            logger.info(f"[AttachmentDB] Reference deleted: {ref_id}")
            return True
        except Exception as e:
            logger.error(f"[AttachmentDB] Failed to delete reference: {e}")
            return False

    def delete_references_by_todo(self, todo_id: str) -> int:
        """
        删除任务的所有引用

        Returns:
            删除的引用数量
        """
        try:
            with self.get_connection() as conn:
                cursor = conn.execute(
                    'DELETE FROM attachment_references WHERE todo_id = ?',
                    (todo_id,)
                )
                conn.commit()
                deleted_count = cursor.rowcount
                logger.info(f"[AttachmentDB] Deleted {deleted_count} references for todo: {todo_id}")
                return deleted_count
        except Exception as e:
            logger.error(f"[AttachmentDB] Failed to delete references: {e}")
            return 0

    # ==================== 配额管理 ====================

    def get_user_quota(self, user_id: str) -> Dict:
        """
        获取用户配额（从视图查询）

        Returns:
            {
                'owned_files_size': int,
                'owned_files_count': int,
                'all_refs_count': int
            }
        """
        results = self.execute_with_retry(
            'SELECT * FROM v_user_quotas WHERE user_id = ?',
            (user_id,)
        )
        if results and len(results) > 0:
            row = results[0]
            return {
                'owned_files_size': row['owned_files_size'] or 0,
                'owned_files_count': row['owned_files_count'] or 0,
                'all_refs_count': row['all_refs_count'] or 0
            }
        return {
            'owned_files_size': 0,
            'owned_files_count': 0,
            'all_refs_count': 0
        }

    def update_user_quota_cache(self, user_id: str) -> bool:
        """更新用户配额缓存表（可选，用于加速查询）"""
        quota = self.get_user_quota(user_id)
        now = int(time.time() * 1000)

        try:
            self.execute_with_retry('''
                INSERT OR REPLACE INTO user_quotas
                (user_id, owned_files_size, owned_files_count, all_refs_count, updated_at)
                VALUES (?, ?, ?, ?, ?)
            ''', (
                user_id,
                quota['owned_files_size'],
                quota['owned_files_count'],
                quota['all_refs_count'],
                now
            ))
            return True
        except Exception as e:
            logger.error(f"[AttachmentDB] Failed to update quota cache: {e}")
            return False

    # ==================== 孤立文件管理 ====================

    def get_orphaned_files(self, grace_hours: int = 24) -> List[Dict]:
        """
        获取孤立文件列表（超过grace_hours的文件）

        Args:
            grace_hours: 宽限期（小时），默认24小时

        Returns:
            孤立文件列表
        """
        results = self.execute_with_retry(
            'SELECT * FROM v_orphaned_files WHERE hours_orphaned >= ?',
            (grace_hours,)
        )
        return [dict(row) for row in results] if results else []

    def cleanup_orphaned_files(self, grace_hours: int = 24, max_count: int = 100) -> Tuple[int, int]:
        """
        清理孤立文件

        Args:
            grace_hours: 宽限期（小时）
            max_count: 单次最多清理数量

        Returns:
            (成功数, 失败数)
        """
        orphaned_files = self.get_orphaned_files(grace_hours)
        orphaned_files = orphaned_files[:max_count]  # 限制数量

        success_count = 0
        failed_count = 0

        for file_info in orphaned_files:
            try:
                if self.delete_file(file_info['file_id'], 'system', 'orphaned'):
                    success_count += 1
                else:
                    failed_count += 1
            except Exception as e:
                logger.error(f"[AttachmentDB] Failed to cleanup file {file_info['file_id']}: {e}")
                failed_count += 1

        logger.info(f"[AttachmentDB] Cleanup complete: {success_count} success, {failed_count} failed")
        return (success_count, failed_count)

    # ==================== 辅助方法 ====================

    def get_attachment_with_file(self, ref_id: str) -> Optional[Dict]:
        """
        获取附件完整信息（引用 + 物理文件）

        Returns:
            {
                'ref_id': str,
                'file_id': str,
                'todo_id': str,
                'user_id': str,
                'display_filename': str,
                'is_owner': bool,
                'source_ref_id': Optional[str],
                'created_at': int,
                'file_hash': str,
                'stored_filename': str,
                'file_size': int,
                'mime_type': str
            }
        """
        results = self.execute_with_retry('''
            SELECT
                r.*,
                f.file_hash,
                f.stored_filename,
                f.file_size,
                f.mime_type
            FROM attachment_references r
            LEFT JOIN attachment_files f ON r.file_id = f.file_id
            WHERE r.ref_id = ?
        ''', (ref_id,))

        if results and len(results) > 0:
            return dict(results[0])
        return None

    def get_attachments_by_todo(self, todo_id: str) -> List[Dict]:
        """
        获取任务的所有附件（引用 + 物理文件）

        Returns:
            附件列表
        """
        results = self.execute_with_retry('''
            SELECT
                r.*,
                f.file_hash,
                f.stored_filename,
                f.file_size,
                f.mime_type,
                f.reference_count
            FROM attachment_references r
            LEFT JOIN attachment_files f ON r.file_id = f.file_id
            WHERE r.todo_id = ?
            ORDER BY r.created_at DESC
        ''', (todo_id,))

        return [dict(row) for row in results] if results else []

    def migrate_attachments(self, old_todo_id: str, new_todo_id: str) -> int:
        """
        将附件引用从旧任务迁移到新任务（用于协作任务转换）

        Args:
            old_todo_id: 原任务ID
            new_todo_id: 新任务ID

        Returns:
            迁移的附件数量
        """
        try:
            # 更新所有引用的 todo_id
            result = self.execute_with_retry('''
                UPDATE attachment_references
                SET todo_id = ?
                WHERE todo_id = ?
            ''', (new_todo_id, old_todo_id))

            # 获取迁移的数量
            count_result = self.execute_with_retry('''
                SELECT COUNT(*) as cnt FROM attachment_references WHERE todo_id = ?
            ''', (new_todo_id,))

            count = count_result[0]['cnt'] if count_result else 0
            logger.info(f"[AttachmentDB] Migrated {count} attachments from {old_todo_id} to {new_todo_id}")
            return count
        except Exception as e:
            logger.error(f"[AttachmentDB] Failed to migrate attachments: {e}")
            return 0
