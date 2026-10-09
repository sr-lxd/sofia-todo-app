"""
附件管理 API 接口 - 引用式系统
版本: v2.1.0
"""
import os
import re
import time
import uuid
import hashlib
import mimetypes
from pathlib import Path
from flask import request, jsonify, send_file, current_app
from werkzeug.utils import secure_filename
from . import todo_bp


def safe_filename(filename):
    """
    安全处理文件名，保留中文字符
    - 去除路径分隔符和危险字符
    - 保留中文、字母、数字、下划线、点、短横线
    - 如果文件名为空，返回默认名称
    """
    if not filename:
        return 'unnamed'

    # 只保留文件名部分（去除路径）
    filename = filename.replace('\\', '/').split('/')[-1]

    # 去除危险字符，保留中文、字母、数字、下划线、点、短横线、空格
    # \u4e00-\u9fff 是常用汉字范围
    # 注意：点号需要在字符类中不转义，或者放在开头/结尾
    filename = re.sub(r'[^\u4e00-\u9fffa-zA-Z0-9_.\-\s]', '', filename)

    # 去除首尾空格
    filename = filename.strip()

    # 如果文件名为空或只有扩展名，返回默认名称
    if not filename or filename.startswith('.'):
        return 'unnamed' + filename if filename.startswith('.') else 'unnamed'

    return filename


# 文件类型白名单
ALLOWED_EXTENSIONS = {
    # 图片
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'raw',
    # 文档
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'txt', 'md', 'csv', 'rtf', 'odt', 'ods', 'odp',
    'pages', 'numbers', 'key',  # Apple iWork
    'wps', 'et', 'dps',  # WPS Office
    # 压缩包
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2',
    # 音频
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'aiff', 'ape',
    # 视频
    'mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'webm', 'm4v', 'mpeg', 'mpg', '3gp',
    # 代码和配置
    'py', 'js', 'ts', 'jsx', 'tsx', 'vue', 'html', 'htm', 'css', 'scss', 'less', 'sass',
    'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg',
    'java', 'cpp', 'c', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bash', 'zsh',
    'sql', 'swift', 'kt', 'kts', 'scala', 'r', 'lua', 'pl', 'pm',
    # 数据和日志
    'log', 'dat', 'db', 'sqlite', 'sqlite3',
    # 字体
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    # 电子书
    'epub', 'mobi', 'azw', 'azw3',
    # 其他常见格式
    'apk', 'ipa', 'exe', 'dmg', 'iso', 'img',
    'psd', 'ai', 'sketch', 'fig', 'xd',  # 设计文件
    'dwg', 'dxf',  # CAD
    'stl', 'obj', 'fbx',  # 3D模型
}

# 文件大小限制
MAX_FILE_SIZE = 233 * 1024 * 1024  # 233MB (斐波那契数)
MAX_USER_QUOTA = 5 * 1024 * 1024 * 1024  # 5GB
MAX_FILES_PER_TODO = 55  # 单个任务最多55个附件


def _get_attachments_db_path():
    return str(Path(current_app.instance_path) / "attachments.sqlite3")


def _get_attachment_storage_dir():
    path = Path(current_app.instance_path) / "attachments"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _allowed_file(filename):
    """检查文件类型是否允许"""
    if '.' not in filename:
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    return ext in ALLOWED_EXTENSIONS


def _calculate_file_hash(file_path):
    """计算文件SHA256哈希"""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def _format_file_size(size_bytes):
    """格式化文件大小显示"""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.1f}{unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f}TB"


# ==================== 附件上传接口 ====================

@todo_bp.route("/api/todos/<todo_id>/attachments", methods=["POST"])
@todo_bp.route("/todo/api/todos/<todo_id>/attachments", methods=["POST"])
def upload_attachment(todo_id):
    """
    上传附件到指定任务 (引用式系统 v2.1.0)

    工作流程:
    1. 计算文件hash
    2. 检查是否已存在相同文件(去重)
    3. 如果不存在,保存物理文件
    4. 创建引用记录
    5. 自动更新引用计数(触发器)
    """
    from .routes import _get_db
    from .db_attachments import AttachmentDB

    # 获取用户ID
    user_id = "localuser"
    if not user_id:
        return jsonify({"code": 400, "error": "缺少user_id参数"}), 400

    db = _get_db()
    # 验证任务权限 - 检查个人任务或协作任务
    todo = db.get_todo(todo_id, user_id)
    if not todo:
        # 检查是否是协作任务的协作者
        if not db.is_collaborator(todo_id, user_id):
            return jsonify({"code": 403, "error": "无权限或任务不存在"}), 403

    # 检查文件
    if 'file' not in request.files:
        return jsonify({"code": 400, "error": "未选择文件"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"code": 400, "error": "文件名为空"}), 400

    # 验证文件类型
    if not _allowed_file(file.filename):
        ext = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else ''
        return jsonify({
            "code": 400,
            "error": f"不支持的文件类型: .{ext}",
            "allowed_types": list(ALLOWED_EXTENSIONS)
        }), 400

    # 验证文件大小
    file.seek(0, 2)  # 移到文件末尾
    file_size = file.tell()
    file.seek(0)  # 移回开头

    if file_size > MAX_FILE_SIZE:
        return jsonify({
            "code": 400,
            "error": f"文件过大（限制{_format_file_size(MAX_FILE_SIZE)}）",
            "file_size": file_size,
            "max_size": MAX_FILE_SIZE
        }), 400

    # 初始化附件数据库
    att_db = AttachmentDB(_get_attachments_db_path())

    # 检查用户配额 (使用新系统:只计算拥有的文件)
    quota = att_db.get_user_quota(user_id)
    if quota['owned_files_size'] + file_size > MAX_USER_QUOTA:
        return jsonify({
            "code": 400,
            "error": "存储空间不足",
            "used": quota['owned_files_size'],
            "quota": MAX_USER_QUOTA,
            "required": file_size
        }), 400

    # 检查单个任务附件数量
    existing_refs = att_db.get_references_by_todo(todo_id)
    if len(existing_refs) >= MAX_FILES_PER_TODO:
        return jsonify({
            "code": 400,
            "error": f"单个任务最多{MAX_FILES_PER_TODO}个附件"
        }), 400

    try:
        # 保存到临时文件并计算hash
        import tempfile
        temp_file = tempfile.NamedTemporaryFile(delete=False)
        temp_path = temp_file.name

        try:
            file.save(temp_path)
            file_hash = _calculate_file_hash(temp_path)
        finally:
            temp_file.close()

        # 检查是否已存在相同文件(去重)
        existing_file = att_db.get_file_by_hash(file_hash)

        file_id = None
        stored_filename = None
        is_new_file = False

        if existing_file:
            # 文件已存在,复用物理文件
            file_id = existing_file['file_id']
            stored_filename = existing_file['stored_filename']
            is_new_file = False
            current_app.logger.info(f"[Upload] File hash match found, reusing: {file_id}")

            # 删除临时文件
            os.remove(temp_path)
        else:
            # 新文件,需要保存物理文件
            now = time.localtime()
            year_month = f"{now.tm_year}/{now.tm_mon:02d}"
            storage_dir = _get_attachment_storage_dir() / year_month
            storage_dir.mkdir(parents=True, exist_ok=True)

            # 生成文件名
            sanitized_filename = safe_filename(file.filename)
            if '.' in sanitized_filename:
                ext = sanitized_filename.rsplit('.', 1)[1].lower()
            else:
                ext = 'bin'
            filename = f"{uuid.uuid4().hex}.{ext}"
            file_path = storage_dir / filename

            # 移动临时文件到存储目录
            import shutil
            shutil.move(temp_path, str(file_path))

            stored_filename = f"{year_month}/{filename}"
            file_id = f"file_{uuid.uuid4().hex[:12]}"
            is_new_file = True

            # 获取MIME类型
            mime_type = mimetypes.guess_type(file.filename)[0] or 'application/octet-stream'

            # 保存物理文件记录到 attachments.db
            if not att_db.add_file({
                'file_id': file_id,
                'file_hash': file_hash,
                'stored_filename': stored_filename,
                'file_size': file_size,
                'mime_type': mime_type,
                'created_by': user_id
            }):
                # 数据库写入失败，删除文件
                os.remove(file_path)
                return jsonify({"code": 500, "error": "数据库写入失败"}), 500

        # 检查同名文件并自动重命名 (v2.4.11 新增)
        original_filename = safe_filename(file.filename)
        display_filename = original_filename

        # 获取当前任务的所有附件文件名
        existing_filenames = [ref['display_filename'] for ref in existing_refs]

        # 如果存在同名文件，自动重命名为 filename_n.ext
        if original_filename in existing_filenames:
            # 分离文件名和扩展名
            if '.' in original_filename:
                name_part = original_filename.rsplit('.', 1)[0]
                ext_part = '.' + original_filename.rsplit('.', 1)[1]
            else:
                name_part = original_filename
                ext_part = ''

            # 查找可用的序号
            n = 1
            while True:
                new_filename = f"{name_part}_{n}{ext_part}"
                if new_filename not in existing_filenames:
                    display_filename = new_filename
                    current_app.logger.info(f"[Upload] Duplicate filename detected, renamed: {original_filename} → {display_filename}")
                    break
                n += 1
                if n > 999:  # 防止无限循环
                    display_filename = f"{name_part}_{uuid.uuid4().hex[:8]}{ext_part}"
                    break

        # 创建引用记录
        ref_id = f"ref_{uuid.uuid4().hex[:12]}"
        if not att_db.add_reference({
            'ref_id': ref_id,
            'file_id': file_id,
            'todo_id': todo_id,
            'user_id': user_id,
            'display_filename': display_filename,
            'is_owner': is_new_file,  # 上传者是所有者
            'source_ref_id': None  # 上传的文件没有来源
        }):
            # 引用创建失败
            if is_new_file:
                # 如果是新文件,需要删除
                file_path = _get_attachment_storage_dir() / stored_filename
                if file_path.exists():
                    os.remove(file_path)
                att_db.delete_file(file_id, user_id, 'upload_failed')
            return jsonify({"code": 500, "error": "创建引用失败"}), 500

        # 返回成功
        renamed_msg = f" (自动重命名为: {display_filename})" if display_filename != original_filename else ""
        return jsonify({
            "code": 0,
            "msg": "上传成功" + (" (复用已存在文件)" if not is_new_file else "") + renamed_msg,
            "data": {
                "id": ref_id,
                "filename": display_filename,  # 返回重命名后的文件名
                "original_filename": original_filename,  # 保留原始文件名供参考
                "file_size": file_size,
                "file_size_text": _format_file_size(file_size),
                "mime_type": existing_file['mime_type'] if existing_file else mime_type,
                "uploaded_at": int(time.time() * 1000),
                "url": f"/todo/api/attachments/{ref_id}/download?user_id={user_id}",
                "is_reused": not is_new_file,
                "was_renamed": display_filename != original_filename
            }
        })

    except Exception as e:
        current_app.logger.exception("Failed to upload attachment")
        # 尝试清理文件
        try:
            if 'temp_path' in locals() and os.path.exists(temp_path):
                os.remove(temp_path)
            if 'file_path' in locals() and os.path.exists(file_path):
                os.remove(file_path)
        except:
            pass
        return jsonify({"code": 500, "error": f"上传失败: {str(e)}"}), 500


# ==================== 获取附件列表接口 ====================

@todo_bp.route("/api/todos/<todo_id>/attachments", methods=["GET"])
@todo_bp.route("/todo/api/todos/<todo_id>/attachments", methods=["GET"])
def get_attachments(todo_id):
    """
    获取任务的所有附件（引用式系统 v2.1.0 + 兼容旧系统）

    返回该任务的所有附件引用及其关联的物理文件信息
    同时兼容旧系统的附件数据
    """
    from .routes import _get_db
    from .db_attachments import AttachmentDB

    # 获取用户ID
    user_id = "localuser"
    if not user_id:
        return jsonify({"code": 400, "error": "缺少user_id参数"}), 400

    db = _get_db()
    # 验证任务权限 - 检查个人任务或协作任务
    todo = db.get_todo(todo_id, user_id)
    is_collaborative = False
    if not todo:
        # 检查是否是协作任务的协作者
        if db.is_collaborator(todo_id, user_id):
            is_collaborative = True
        else:
            return jsonify({"code": 403, "error": "无权限或任务不存在"}), 403

    formatted_attachments = []
    total_size = 0

    try:
        # 1. 获取新系统的附件（attachments.db）
        att_db = AttachmentDB(_get_attachments_db_path())
        new_attachments = att_db.get_attachments_by_todo(todo_id)

        for att in new_attachments:
            total_size += att['file_size']
            formatted_attachments.append({
                "id": att['ref_id'],  # 返回引用ID
                "filename": att['display_filename'],
                "file_size": att['file_size'],
                "file_size_text": _format_file_size(att['file_size']),
                "mime_type": att['mime_type'],
                "uploaded_at": att['created_at'],
                "can_preview": att['mime_type'].startswith('image/'),
                "is_owner": bool(att['is_owner']),  # 是否为所有者
                "is_shared": att['source_ref_id'] is not None,  # 是否为分享来的
                "download_url": f"/todo/api/attachments/{att['ref_id']}/download?user_id={user_id}"
            })
    except Exception as e:
        current_app.logger.warning(f"[Attachments] Failed to load from new system: {e}")

    # 2. 获取旧系统的附件（sofia.db）- 向后兼容
    try:
        old_attachments = _get_db().get_attachments(todo_id)
        for att in old_attachments:
            total_size += att['file_size']
            formatted_attachments.append({
                "id": att['id'],
                "filename": att['filename'],
                "file_size": att['file_size'],
                "file_size_text": _format_file_size(att['file_size']),
                "mime_type": att['mime_type'],
                "uploaded_at": att['uploaded_at'],
                "can_preview": att['mime_type'].startswith('image/'),
                "is_owner": True,  # 旧系统的附件默认为所有者
                "is_shared": False,  # 旧系统没有分享概念
                "is_legacy": True,  # 标记为旧系统附件
                "download_url": f"/todo/api/attachments/{att['id']}/download?user_id={user_id}"
            })
    except Exception as e:
        current_app.logger.warning(f"[Attachments] Failed to load from legacy system: {e}")

    return jsonify({
        "code": 0,
        "data": {
            "attachments": formatted_attachments,
            "total_count": len(formatted_attachments),
            "total_size": total_size,
            "total_size_text": _format_file_size(total_size)
        }
    })


# ==================== 下载附件接口 ====================

@todo_bp.route("/api/attachments/<att_id>/download", methods=["GET"])
@todo_bp.route("/todo/api/attachments/<att_id>/download", methods=["GET"])
def download_attachment(att_id):
    """
    下载附件（引用式系统 v2.1.0 + 兼容旧系统）

    通过引用ID查找物理文件并下载
    同时兼容旧系统的附件ID
    """
    from .routes import _get_db
    from .db_attachments import AttachmentDB

    # 获取用户ID
    user_id = "localuser"
    if not user_id:
        return jsonify({"code": 400, "error": "缺少user_id参数"}), 400

    att = None
    is_legacy = False

    # 1. 尝试从新系统获取（attachments.db）
    try:
        att_db = AttachmentDB(_get_attachments_db_path())
        att = att_db.get_attachment_with_file(att_id)
        if att:
            is_legacy = False
    except Exception as e:
        current_app.logger.warning(f"[Attachments] Failed to load from new system: {e}")

    # 2. 如果新系统没找到，尝试从旧系统获取（sofia.db）
    if not att:
        try:
            att = _get_db().get_attachment(att_id)
            if att:
                is_legacy = True
        except Exception as e:
            current_app.logger.warning(f"[Attachments] Failed to load from legacy system: {e}")

    # 3. 都没找到，返回404
    if not att:
        return jsonify({"code": 404, "error": "附件不存在"}), 404

    db = _get_db()
    # 4. 验证权限（检查个人任务或协作任务）
    todo = db.get_todo(att['todo_id'], user_id)
    if not todo:
        # 检查是否是协作任务的协作者
        if not db.is_collaborator(att['todo_id'], user_id):
            return jsonify({"code": 403, "error": "无权限"}), 403

    # 5. 构建文件路径
    file_path = _get_attachment_storage_dir() / att['stored_filename']

    if not file_path.exists():
        current_app.logger.error(f"Attachment file not found: {file_path}")
        return jsonify({"code": 404, "error": "文件不存在"}), 404

    # 6. 发送文件
    try:
        # 新系统使用display_filename，旧系统使用filename
        download_name = att.get('display_filename') or att.get('filename', 'download')
        return send_file(
            str(file_path),
            as_attachment=True,
            download_name=download_name,
            mimetype=att['mime_type']
        )
    except Exception as e:
        current_app.logger.exception("Failed to send file")
        return jsonify({"code": 500, "error": f"下载失败: {str(e)}"}), 500


# ==================== 删除附件接口 ====================

@todo_bp.route("/api/attachments/<att_id>", methods=["DELETE"])
@todo_bp.route("/todo/api/attachments/<att_id>", methods=["DELETE"])
def delete_attachment(att_id):
    """
    删除附件（引用式系统 v2.1.0 + 兼容旧系统）

    工作流程（新系统）:
    1. 删除引用记录
    2. 触发器自动减少引用计数
    3. 如果引用计数=0，触发器自动标记为孤立
    4. 物理文件不立即删除，等待清理任务

    工作流程（旧系统）:
    1. 删除物理文件
    2. 删除数据库记录
    """
    from .routes import _get_db
    from .db_attachments import AttachmentDB

    # 获取用户ID
    user_id = "localuser"
    if not user_id:
        return jsonify({"code": 400, "error": "缺少user_id参数"}), 400

    ref = None
    is_legacy = False

    # 1. 尝试从新系统获取（attachments.db）
    try:
        att_db = AttachmentDB(_get_attachments_db_path())
        ref = att_db.get_reference(att_id)
        if ref:
            is_legacy = False
    except Exception as e:
        current_app.logger.warning(f"[Attachments] Failed to load from new system: {e}")

    # 2. 如果新系统没找到，尝试从旧系统获取（sofia.db）
    if not ref:
        try:
            ref = _get_db().get_attachment(att_id)
            if ref:
                is_legacy = True
        except Exception as e:
            current_app.logger.warning(f"[Attachments] Failed to load from legacy system: {e}")

    # 3. 都没找到，返回404
    if not ref:
        return jsonify({"code": 404, "error": "附件不存在"}), 404

    db = _get_db()
    # 4. 验证权限（检查个人任务或协作任务）
    todo = db.get_todo(ref['todo_id'], user_id)
    if not todo:
        # 检查是否是协作任务的协作者
        if not db.is_collaborator(ref['todo_id'], user_id):
            return jsonify({"code": 403, "error": "无权限"}), 403

    try:
        if is_legacy:
            # 旧系统：直接删除文件和记录
            file_path = _get_attachment_storage_dir() / ref['stored_filename']
            if file_path.exists():
                os.remove(file_path)
            else:
                current_app.logger.warning(f"Attachment file not found: {file_path}")

            if not _get_db().delete_attachment(att_id):
                return jsonify({"code": 500, "error": "数据库删除失败"}), 500

            current_app.logger.info(f"[Attachment Delete] Legacy attachment {att_id} deleted by {user_id}")
        else:
            # 新系统：删除引用记录（触发器会自动更新引用计数）
            if not att_db.delete_reference(att_id):
                return jsonify({"code": 500, "error": "删除引用失败"}), 500

            current_app.logger.info(
                f"[Attachment Delete] Reference {att_id} deleted by {user_id}. "
                f"Physical file {ref.get('file_id', 'unknown')} will be cleaned if orphaned."
            )

        return jsonify({
            "code": 0,
            "msg": "删除成功"
        })

    except Exception as e:
        current_app.logger.exception("Failed to delete attachment")
        return jsonify({"code": 500, "error": f"删除失败: {str(e)}"}), 500


# ==================== 删除任务时清理附件接口 ====================

@todo_bp.route("/api/todos/<todo_id>/attachments/cleanup", methods=["DELETE"])
@todo_bp.route("/todo/api/todos/<todo_id>/attachments/cleanup", methods=["DELETE"])
def cleanup_task_attachments(todo_id):
    """
    删除任务时清理关联的附件

    参数:
    - user_id: 用户ID
    - delete_files: 是否删除物理文件（true/false，默认false）

    工作流程:
    1. 获取任务的所有附件引用
    2. 删除所有引用记录
    3. 如果 delete_files=true，删除引用计数为0的物理文件
    """
    from .routes import _get_db
    from .db_attachments import AttachmentDB

    # 获取参数
    user_id = "localuser"
    if not user_id:
        return jsonify({"code": 400, "error": "缺少user_id参数"}), 400

    delete_files = request.args.get("delete_files", "false").lower() == "true"

    db = _get_db()
    # 验证任务权限 - 检查个人任务或协作任务
    todo = db.get_todo(todo_id, user_id)
    if not todo:
        # 检查是否是协作任务的协作者
        if not db.is_collaborator(todo_id, user_id):
            # 任务不存在或不属于该用户，可能已经被删除
            return jsonify({"code": 0, "msg": "任务不存在或已删除"})

    deleted_refs = 0
    deleted_files = 0
    errors = []

    try:
        att_db = AttachmentDB(_get_attachments_db_path())

        # 获取任务的所有附件引用
        attachments = att_db.get_attachments_by_todo(todo_id)

        for att in attachments:
            try:
                ref_id = att['ref_id']
                file_id = att.get('file_id')

                # 获取删除前的引用计数
                file_info = att_db.get_file(file_id) if file_id else None
                ref_count_before = file_info['ref_count'] if file_info else 0

                # 删除引用
                if att_db.delete_reference(ref_id):
                    deleted_refs += 1

                    # 如果需要删除物理文件，且引用计数将变为0
                    if delete_files and ref_count_before <= 1 and file_info:
                        # 删除物理文件
                        file_path = _get_attachment_storage_dir() / file_info['stored_filename']
                        if file_path.exists():
                            os.remove(file_path)
                            deleted_files += 1
                            current_app.logger.info(
                                f"[Attachment Cleanup] Deleted physical file: {file_info['stored_filename']}"
                            )

                        # 删除文件记录
                        att_db.delete_file(file_id, user_id, 'task_deleted')

            except Exception as e:
                errors.append(f"Failed to delete ref {att.get('ref_id', 'unknown')}: {str(e)}")
                current_app.logger.warning(f"[Attachment Cleanup] {errors[-1]}")

        # 处理旧系统附件
        try:
            old_attachments = _get_db().get_attachments(todo_id)
            for att in old_attachments:
                try:
                    if delete_files:
                        file_path = _get_attachment_storage_dir() / att['stored_filename']
                        if file_path.exists():
                            os.remove(file_path)
                            deleted_files += 1

                    if _get_db().delete_attachment(att['id']):
                        deleted_refs += 1
                except Exception as e:
                    errors.append(f"Failed to delete legacy attachment {att.get('id', 'unknown')}: {str(e)}")
        except Exception as e:
            current_app.logger.warning(f"[Attachment Cleanup] Failed to process legacy attachments: {e}")

        current_app.logger.info(
            f"[Attachment Cleanup] Task {todo_id}: deleted {deleted_refs} refs, "
            f"{deleted_files} files, {len(errors)} errors"
        )

        return jsonify({
            "code": 0,
            "msg": "清理完成",
            "data": {
                "deleted_refs": deleted_refs,
                "deleted_files": deleted_files,
                "errors": errors
            }
        })

    except Exception as e:
        current_app.logger.exception("Failed to cleanup attachments")
        return jsonify({"code": 500, "error": f"清理失败: {str(e)}"}), 500


# ==================== 获取用户配额接口 ====================

@todo_bp.route("/api/users/<user_id>/quota", methods=["GET"])
@todo_bp.route("/todo/api/users/<user_id>/quota", methods=["GET"])
def get_user_quota(user_id):
    """
    获取用户附件配额使用情况（引用式系统 v2.1.0 + 兼容旧系统）

    只计算用户拥有的文件大小，分享来的不计入配额
    同时兼容旧系统的附件数据
    """
    from .db_attachments import AttachmentDB
    from .routes import _get_db

    # 简单验证（实际应用中可能需要更严格的验证）
    request_user_id = "localuser"
    if request_user_id != user_id.lower():
        return jsonify({"code": 403, "error": "无权限"}), 403

    owned_files_size = 0
    owned_files_count = 0
    all_refs_count = 0

    # 1. 获取新系统配额（attachments.db）
    try:
        att_db = AttachmentDB(_get_attachments_db_path())
        quota = att_db.get_user_quota(user_id)
        owned_files_size += quota['owned_files_size']
        owned_files_count += quota['owned_files_count']
        all_refs_count += quota['all_refs_count']
    except Exception as e:
        current_app.logger.warning(f"[Quota] Failed to get quota from new system: {e}")

    # 2. 获取旧系统配额（sofia.db）- 向后兼容
    try:
        legacy_stats = _get_db().get_user_attachments_stats(user_id)
        owned_files_size += legacy_stats['total_size']
        owned_files_count += legacy_stats['file_count']
        all_refs_count += legacy_stats['file_count']  # 旧系统没有引用概念，文件数=引用数
    except Exception as e:
        current_app.logger.warning(f"[Quota] Failed to get quota from legacy system: {e}")

    return jsonify({
        "code": 0,
        "data": {
            "used": owned_files_size,  # 只计算拥有的文件
            "used_text": _format_file_size(owned_files_size),
            "total": MAX_USER_QUOTA,
            "total_text": _format_file_size(MAX_USER_QUOTA),
            "percentage": round((owned_files_size / MAX_USER_QUOTA) * 100, 1) if MAX_USER_QUOTA > 0 else 0,
            "owned_file_count": owned_files_count,  # 拥有的文件数
            "all_refs_count": all_refs_count,  # 所有引用数（包括分享的）
            "max_files_per_todo": MAX_FILES_PER_TODO
        }
    })


# ==================== 分享附件辅助函数 ====================

def copy_attachments_for_share(source_todo_id, source_user_id, target_todo_id, target_user_id):
    """
    分享附件到目标用户（引用式系统 v2.1.0）

    工作流程:
    1. 获取源任务的所有引用
    2. 为每个引用创建新的引用记录
    3. 不复制物理文件，只创建引用
    4. 分享者不占用目标用户配额

    Args:
        source_todo_id: 源任务ID
        source_user_id: 源用户ID
        target_todo_id: 目标任务ID（分享后生成的新任务ID）
        target_user_id: 目标用户ID

    Returns:
        (成功数, 失败数, 总大小)
    """
    from .db_attachments import AttachmentDB
    from flask import current_app

    att_db = AttachmentDB(_get_attachments_db_path())

    # 获取源任务的所有附件引用
    source_refs = att_db.get_attachments_by_todo(source_todo_id)

    if not source_refs:
        return (0, 0, 0)  # 没有附件

    success_count = 0
    failed_count = 0
    total_size = 0

    for source_ref in source_refs:
        try:
            # 检查物理文件是否存在
            file_info = att_db.get_file(source_ref['file_id'])
            if not file_info:
                current_app.logger.warning(
                    f"[Attachment Share] File not found: {source_ref['file_id']}"
                )
                failed_count += 1
                continue

            # 创建新的引用记录（不复制物理文件）
            new_ref_id = f"ref_{uuid.uuid4().hex[:12]}"
            if att_db.add_reference({
                'ref_id': new_ref_id,
                'file_id': source_ref['file_id'],  # 引用同一个物理文件
                'todo_id': target_todo_id,
                'user_id': target_user_id,
                'display_filename': source_ref['display_filename'],
                'is_owner': 0,  # 分享来的附件，用户不是所有者
                'source_ref_id': source_ref['ref_id']  # 记录分享来源
            }):
                success_count += 1
                total_size += file_info['file_size']
                current_app.logger.info(
                    f"[Attachment Share] Created reference {new_ref_id} "
                    f"for file {source_ref['file_id']} (user: {target_user_id})"
                )
            else:
                failed_count += 1
                current_app.logger.error(
                    f"[Attachment Share] Failed to create reference for {source_ref['display_filename']}"
                )

        except Exception as e:
            current_app.logger.exception(
                f"[Attachment Share] Failed to share attachment {source_ref.get('display_filename', 'unknown')}: {e}"
            )
            failed_count += 1

    current_app.logger.info(
        f"[Attachment Share] Completed: {success_count} success, {failed_count} failed, "
        f"total size: {_format_file_size(total_size)} (referenced, not copied)"
    )
    return (success_count, failed_count, total_size)


@todo_bp.route("/api/batch-attachment-counts", methods=["POST"])
@todo_bp.route("/todo/api/batch-attachment-counts", methods=["POST"])
def batch_attachment_counts():
    """批量获取多个任务的附件数量（优化内存使用）"""
    att_db = None
    try:
        from .db_attachments import AttachmentDB

        data = request.get_json()
        user_id = 'localuser'
        todo_ids = data.get('todo_ids', [])

        if not user_id:
            return jsonify({'success': False, 'error': '缺少user_id参数'}), 400

        if not todo_ids or not isinstance(todo_ids, list):
            return jsonify({'success': False, 'error': '缺少todo_ids参数或格式错误'}), 400

        # 初始化数据库
        att_db = AttachmentDB(_get_attachments_db_path())

        # 批量查询所有任务的附件数量
        counts = {}
        for todo_id in todo_ids:
            try:
                # 获取该任务的所有附件引用
                attachments = att_db.get_attachments_by_todo(todo_id)
                # 使用生成器表达式代替列表推导式，减少内存占用
                count = sum(1 for a in attachments if a.get('user_id') == user_id)
                counts[todo_id] = count
                # 显式删除临时对象
                del attachments
            except Exception as e:
                # 单个任务失败不影响其他任务
                current_app.logger.warning(f"Failed to get attachment count for {todo_id}: {e}")
                counts[todo_id] = 0

        return jsonify({
            'success': True,
            'data': {
                'counts': counts,
                'total_count': len(counts)
            }
        })
    except Exception as e:
        current_app.logger.exception("Batch attachment counts failed")
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        # 确保数据库连接被关闭
        if att_db is not None:
            try:
                if hasattr(att_db, 'close'):
                    att_db.close()
                elif hasattr(att_db, 'conn') and att_db.conn:
                    att_db.conn.close()
            except Exception as e:
                current_app.logger.warning(f"Failed to close database: {e}")

        # 显式触发垃圾回收
        import gc
        gc.collect()
