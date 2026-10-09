import json
import time
from pathlib import Path
from flask import current_app, jsonify, render_template, request, session
from werkzeug.exceptions import BadRequest
from functools import wraps
import configparser

# 关键点：复用 __init__.py 里创建的同一个蓝图实例
from . import todo_bp, STATIC_VERSION

_USER_ID_PARAM = "user_id"

# ========= 数据存储配置 =========
# 使用 SQLite 数据库（已移除JSON模式）
_db_instance = None

# 导入数据库模块
from .db_sqlite import SQLiteDB

def _get_db():
    global _db_instance
    if _db_instance is None:
        db_path = Path(current_app.instance_path) / "todo.sqlite3"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        _db_instance = SQLiteDB(str(db_path))
    if not _db_instance.user_exists("localuser"):
        _db_instance.create_user("localuser", "本机用户")
    return _db_instance

# 禁用静态文件缓存（开发模式）
@todo_bp.after_request
def add_header(response):
    # 对CSS和JS文件禁用缓存
    if request.path.endswith(('.css', '.js')):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

# 读取管理员密码
def _get_admin_password():
    return ""

# 管理员权限验证装饰器
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('is_admin'):
            return jsonify({"code": 403, "msg": "需要管理员权限"}), 403
        return f(*args, **kwargs)
    return decorated_function

# ========= 页面路由 =========

# 既匹配 /todo/ 也匹配 /todo（规避严格斜杠问题）
@todo_bp.route("", methods=["GET"])
@todo_bp.route("/", methods=["GET"])
def index():
    return render_template(
        "todo_index.html",
        page_title="Sofia 记事清单",
        version=f"v{STATIC_VERSION}",
        static_version=STATIC_VERSION,
        developer="Sofia 记事清单单机版",
    )

# 帮助页面
# 附件管理页面
@todo_bp.route("/attachments", methods=["GET"])
def attachments_page():
    """独立的附件管理页面"""
    return render_template(
        "attachments.html",
        static_version=STATIC_VERSION,
    )

@todo_bp.route("/help", methods=["GET"])
def help():
    return render_template(
        "to-do-list_help.html",
        version=f"v{STATIC_VERSION}",
        static_version=STATIC_VERSION,
        developer="Sofia 记事清单单机版",
    )

# 协作共享页面
@todo_bp.route("/collaborate", methods=["GET"])
def collaborate_page():
    """协作共享管理页面"""
    return render_template(
        "collaborate.html",
        static_version=STATIC_VERSION,
    )

# 昵称设置页面（独立窗口）
@todo_bp.route("/nickname", methods=["GET"])
def nickname_page():
    return render_template(
        "nickname.html",
        version="v1.7.6",
    )


# 健康检查：/todo/ping
@todo_bp.route("/ping", methods=["GET"])
def ping():
    return jsonify({"status": "ok", "bp": "todo"}), 200

# ========= API 路由 =========

@todo_bp.route("/api/items", methods=["GET"])
@todo_bp.route("/todo/api/items", methods=["GET"])
def get_items():
    user_id = _extract_user_id()
    if not _user_exists(user_id):
        return jsonify({"code": 403, "msg": "用户未注册"}), 403
    payload = _load_payload(user_id)
    return jsonify(payload)

@todo_bp.route("/api/items", methods=["PUT"])
@todo_bp.route("/todo/api/items", methods=["PUT"])
def put_items():
    user_id = _extract_user_id()
    if not _user_exists(user_id):
        return jsonify({"code": 403, "msg": "用户未注册"}), 403
    try:
        data = request.get_json(force=True)
    except BadRequest as exc:
        raise BadRequest("请求体必须是合法的 JSON") from exc

    if not isinstance(data, dict):
        raise BadRequest("JSON 顶层必须是对象")

    items = data.get("items")
    preferences = data.get("preferences")

    if items is not None and not isinstance(items, list):
        raise BadRequest("items 字段必须是数组")
    if preferences is not None and not isinstance(preferences, dict):
        raise BadRequest("preferences 字段必须是对象")

    payload = {"items": items or [], "preferences": preferences or {}}
    try:
        _save_payload(user_id, payload)
        return jsonify({"status": "ok"})
    except Exception as e:
        current_app.logger.exception(f"Failed to save payload for user {user_id}")
        return jsonify({"code": 500, "msg": f"保存失败: {str(e)}"}), 500


# ============ 协作任务API ============

@todo_bp.route("/api/collaborate", methods=["POST"])
@todo_bp.route("/todo/api/collaborate", methods=["POST"])
def create_collaborate():
    """创建协作任务 / 将个人任务转为协作任务"""
    user_id = _extract_user_id()
    if not _user_exists(user_id):
        return jsonify({"code": 403, "msg": "用户未注册"}), 403

    try:
        data = request.get_json(force=True)
    except:
        return jsonify({"code": 400, "msg": "无效的JSON"}), 400

    todo_data = data.get("todo")
    collaborator_ids = data.get("collaborators", [])
    original_todo_id = data.get("originalTodoId")  # 如果是转换现有任务

    if not collaborator_ids:
        return jsonify({"code": 400, "msg": "至少需要一个协作者"}), 400

    db = _get_db()

    # 验证所有协作者是否存在
    valid_collaborators = []
    for cid in collaborator_ids:
        if cid != user_id and db.user_exists(cid):
            valid_collaborators.append(cid)

    if not valid_collaborators:
        return jsonify({"code": 400, "msg": "没有有效的协作者"}), 400

    try:
        if original_todo_id:
            # 将现有任务转为协作任务
            # 使用前端传来的 todo_data（包含完整任务信息）
            if not todo_data:
                return jsonify({"code": 400, "msg": "缺少任务数据"}), 400
            all_users = [user_id] + valid_collaborators
            new_todo_id = db.create_collaborative_todo(todo_data, all_users)

            # 迁移附件引用到新的协作任务
            try:
                from .db_attachments import AttachmentDB
                from .routes_attachments import _get_attachments_db_path
                att_db = AttachmentDB(_get_attachments_db_path())
                migrated = att_db.migrate_attachments(original_todo_id, new_todo_id)
                print(f"[Collaborate] Migrated {migrated} attachments from {original_todo_id} to {new_todo_id}")
            except Exception as e:
                print(f"[Collaborate] Failed to migrate attachments: {e}")

            # 删除原个人任务
            deleted = db.delete_todo(original_todo_id, user_id)
            print(f"[Collaborate] Converted todo {original_todo_id} -> {new_todo_id}, deleted={deleted}")
        else:
            # 创建新的协作任务
            all_users = [user_id] + valid_collaborators
            new_todo_id = db.create_collaborative_todo(todo_data or {}, all_users)

        # 获取协作者昵称
        collaborators_info = db.get_collaborators_info(new_todo_id)

        return jsonify({
            "status": "ok",
            "todoId": new_todo_id,
            "collaborators": collaborators_info,
            "msg": f"已创建协作任务，共 {len(collaborators_info)} 人协作"
        })
    except Exception as e:
        current_app.logger.exception("创建协作任务失败")
        return jsonify({"code": 500, "msg": str(e)}), 500


@todo_bp.route("/api/collaborate/<todo_id>", methods=["GET"])
@todo_bp.route("/todo/api/collaborate/<todo_id>", methods=["GET"])
def get_collaborators(todo_id):
    """获取协作任务的协作者列表"""
    user_id = _extract_user_id()
    if not _user_exists(user_id):
        return jsonify({"code": 403, "msg": "用户未注册"}), 403

    db = _get_db()

    # 验证用户是协作者
    if not db.is_collaborator(todo_id, user_id):
        return jsonify({"code": 403, "msg": "无权限查看"}), 403

    collaborators = db.get_collaborators_info(todo_id)
    return jsonify({
        "status": "ok",
        "collaborators": collaborators
    })


@todo_bp.route("/api/collaborate/<todo_id>/invite", methods=["POST"])
@todo_bp.route("/todo/api/collaborate/<todo_id>/invite", methods=["POST"])
def invite_collaborators(todo_id):
    """邀请新协作者"""
    user_id = _extract_user_id()
    if not _user_exists(user_id):
        return jsonify({"code": 403, "msg": "用户未注册"}), 403

    try:
        data = request.get_json(force=True)
    except:
        return jsonify({"code": 400, "msg": "无效的JSON"}), 400

    invitee_ids = data.get("collaborators", [])
    if not invitee_ids:
        return jsonify({"code": 400, "msg": "请指定要邀请的用户"}), 400

    db = _get_db()

    # 验证用户是协作者
    if not db.is_collaborator(todo_id, user_id):
        return jsonify({"code": 403, "msg": "无权限邀请"}), 403

    added = db.add_collaborators(todo_id, invitee_ids)

    return jsonify({
        "status": "ok",
        "added": added,
        "msg": f"已添加 {len(added)} 个协作者" if added else "没有新增协作者"
    })


@todo_bp.route("/api/collaborate/<todo_id>", methods=["DELETE"])
@todo_bp.route("/todo/api/collaborate/<todo_id>", methods=["DELETE"])
def leave_collaborate(todo_id):
    """退出协作 / 删除协作任务"""
    user_id = _extract_user_id()
    if not _user_exists(user_id):
        return jsonify({"code": 403, "msg": "用户未注册"}), 403

    db = _get_db()

    # 验证用户是协作者
    if not db.is_collaborator(todo_id, user_id):
        return jsonify({"code": 403, "msg": "无权限操作"}), 403

    result = db.remove_collaborator(todo_id, user_id)

    if result['status'] == 'left':
        return jsonify({
            "status": "left",
            "msg": "已退出协作，任务对其他协作者仍然可见"
        })
    elif result['status'] == 'converted':
        return jsonify({
            "status": "converted",
            "msg": "已退出协作，任务已转为对方的个人任务"
        })
    else:
        # 最后一人，任务已删除，同时删除附件目录
        try:
            import shutil
            attachments_dir = Path(current_app.config.get('UPLOAD_FOLDER', 'data/attachments')) / 'collaborative' / todo_id
            if attachments_dir.exists():
                shutil.rmtree(attachments_dir)
        except Exception as e:
            current_app.logger.error(f"删除协作附件目录失败: {e}")

        return jsonify({
            "status": "deleted",
            "msg": "任务已删除（你是最后一个协作者）"
        })


@todo_bp.route("/api/items/share", methods=["POST"])
@todo_bp.route("/todo/api/items/share", methods=["POST"])
def share_item():
    """分享任务给其他用户（支持用户ID或昵称，支持多用户分享）"""
    try:
        data = request.get_json(force=True)
        todo = data.get("todo")

        # ✅ 支持多用户分享：优先读取 target_users 数组，向后兼容单用户
        target_users = data.get("target_users")
        if not target_users:
            # 兼容旧版单用户格式
            target_identifier = (
                data.get("target_user")
                or data.get("target_user_id")
                or ""
            ).strip()
            target_users = [target_identifier] if target_identifier else []

    except BadRequest as e:
        current_app.logger.error(f"[todo] Share - JSON parse error: {e}")
        return jsonify({"error": "请求体格式错误，请确保发送的是有效的JSON"}), 400
    except Exception as e:
        current_app.logger.error(f"[todo] Share - Unexpected error: {e}")
        return jsonify({"error": "请求处理错误"}), 400

    # 验证输入
    if not target_users or not isinstance(target_users, list) or len(target_users) == 0:
        return jsonify({"error": "请输入目标用户的ID或昵称"}), 400

    # 验证todo对象
    if not todo or not isinstance(todo, dict):
        return jsonify({"error": "任务数据无效"}), 400

    # 🎁 彩蛋功能：检测"@all"等特殊关键词，分享给所有人
    BROADCAST_KEYWORDS = [
        "@all", "@All", "@ALL",
        "@所有人", "@全部", "@所有",
        "@全部用户", "@所有用户"
    ]

    # 检查是否包含广播关键词
    has_broadcast = any(keyword in target_users for keyword in BROADCAST_KEYWORDS)

    if has_broadcast:
        # 获取当前用户ID（从session或request中）
        try:
            current_user_id = (
                request.args.get("user_id")
                or request.headers.get("X-Todo-User")
                or ""
            ).strip().lower()
        except Exception:
            current_user_id = ""

        # 获取所有用户（排除自己）
        profiles = _load_user_profiles()
        all_user_ids = [uid for uid in profiles.keys() if uid != current_user_id]

        # 替换target_users为所有用户ID
        target_users = all_user_ids

        current_app.logger.info(f"[todo] Broadcast share: {len(all_user_ids)} users")

    # 批量分享给多个用户
    results = []
    success_count = 0
    failed_count = 0

    # ✅ 优化：一次性加载所有用户资料，避免重复读取文件
    all_profiles = _load_user_profiles()

    for target_identifier in target_users:
        target_identifier = str(target_identifier).strip()

        if not target_identifier:
            results.append({
                "identifier": target_identifier,
                "success": False,
                "error": "用户标识为空"
            })
            failed_count += 1
            continue

        # 查找目标用户（使用预加载的资料）
        target_user_id, target_nickname = _find_user_in_profiles(target_identifier, all_profiles)

        if not target_user_id:
            results.append({
                "identifier": target_identifier,
                "success": False,
                "error": f"未找到用户「{target_identifier}」"
            })
            failed_count += 1
            continue

        try:
            # 获取署名信息
            signed = data.get("signed", True)  # 默认署名
            from_nickname = data.get("from_nickname", "")

            # 加载目标用户的payload
            payload = _load_payload(target_user_id)
            items = payload.get("items", [])

            # 生成新的UUID避免ID冲突
            import uuid

            # 处理任务标题（署名分享时添加前缀）
            original_title = todo.get("title", "")
            if signed and from_nickname:
                shared_title = f"[来自{from_nickname}分享] {original_title}"
            else:
                shared_title = original_title

            shared_todo = {
                "id": str(uuid.uuid4()),
                "title": shared_title,  # ← 使用处理后的标题
                "content": todo.get("content", ""),
                "completed": False,  # 分享的任务默认未完成
                "pinned": False,
                "startAt": todo.get("startAt"),
                "repeatDaily": todo.get("repeatDaily", False),
                "repeatConfig": todo.get("repeatConfig", {"mode": "none", "hours": 0}),
                "createdAt": todo.get("createdAt"),
                "updatedAt": todo.get("updatedAt"),
            }

            # 插入到目标用户的任务列表开头
            items.insert(0, shared_todo)
            payload["items"] = items

            # 保存到目标用户文件
            _save_payload(target_user_id, payload)

            # ✅ 复制附件到目标用户
            att_success = 0
            att_failed = 0
            att_size = 0
            try:
                from .routes_attachments import copy_attachments_for_share
                source_todo_id = todo.get("id")

                # 优先使用前端直接传递的source_user_id，向后兼容通过昵称查找
                source_user_id = data.get("source_user_id", "").strip().lower()

                if not source_user_id:
                    # 向后兼容：通过昵称查找分享者的user_id
                    from_nickname = data.get("from_nickname", "")
                    if from_nickname:
                        source_user_id, _ = _find_user_by_id_or_nickname(from_nickname)

                if source_todo_id and source_user_id:
                    att_success, att_failed, att_size = copy_attachments_for_share(
                        source_todo_id=source_todo_id,
                        source_user_id=source_user_id,
                        target_todo_id=shared_todo["id"],
                        target_user_id=target_user_id
                    )
                    if att_success > 0:
                        current_app.logger.info(
                            f"[todo] Copied {att_success} attachments "
                            f"({att_size} bytes) from {source_user_id} to {target_user_id}"
                        )
            except Exception as e:
                current_app.logger.warning(f"[todo] Failed to copy attachments: {e}")
                # 附件复制失败不影响任务分享

            # 记录成功
            display_name = target_nickname if target_nickname else target_user_id
            results.append({
                "identifier": target_identifier,
                "success": True,
                "target_user_id": target_user_id,
                "target_nickname": target_nickname,
                "display_name": display_name,
                "shared_todo_id": shared_todo["id"],  # ← 返回分享后的任务ID，用于撤回
                "attachments_copied": att_success,  # ← 新增：附件复制数量
                "attachments_failed": att_failed,   # ← 新增：附件复制失败数量
                "attachments_size": att_size        # ← 新增：附件总大小
            })
            success_count += 1

        except Exception as e:
            current_app.logger.exception(f"Failed to share todo to {target_identifier}")
            results.append({
                "identifier": target_identifier,
                "success": False,
                "error": "服务器错误"
            })
            failed_count += 1

    # 返回分享结果
    if success_count == 0:
        # 全部失败
        return jsonify({
            "status": "error",
            "error": "所有用户分享失败",
            "results": results
        }), 400
    else:
        # 至少有一个成功
        return jsonify({
            "status": "ok",
            "msg": f"成功分享给 {success_count} 个用户" + (f"，失败 {failed_count} 个" if failed_count > 0 else ""),
            "success_count": success_count,
            "failed_count": failed_count,
            "results": results
        })


@todo_bp.route("/api/items/share/revoke", methods=["POST"])
@todo_bp.route("/todo/api/items/share/revoke", methods=["POST"])
def revoke_share():
    """撤回分享：删除之前分享给其他用户的任务"""
    try:
        data = request.get_json(force=True)
        share_records = data.get("share_records", [])
    except BadRequest as e:
        current_app.logger.error(f"[todo] Revoke share - JSON parse error: {e}")
        return jsonify({"error": "请求体格式错误"}), 400
    except Exception as e:
        current_app.logger.error(f"[todo] Revoke share - Unexpected error: {e}")
        return jsonify({"error": "请求处理错误"}), 400

    # 验证输入
    if not share_records or not isinstance(share_records, list):
        return jsonify({"error": "无效的分享记录"}), 400

    success_count = 0
    failed_count = 0
    results = []

    for record in share_records:
        target_user_id = record.get("target_user_id", "").strip()
        shared_todo_id = record.get("shared_todo_id", "").strip()

        if not target_user_id or not shared_todo_id:
            failed_count += 1
            results.append({
                "target_user_id": target_user_id,
                "shared_todo_id": shared_todo_id,
                "success": False,
                "error": "缺少必要参数"
            })
            continue

        try:
            # 加载目标用户的payload
            payload = _load_payload(target_user_id)
            items = payload.get("items", [])

            # 查找并删除指定ID的任务
            original_count = len(items)
            items = [item for item in items if item.get("id") != shared_todo_id]

            if len(items) < original_count:
                # 任务被删除
                payload["items"] = items
                _save_payload(target_user_id, payload)

                success_count += 1
                results.append({
                    "target_user_id": target_user_id,
                    "shared_todo_id": shared_todo_id,
                    "success": True
                })
            else:
                # 任务未找到（可能已被对方删除）
                failed_count += 1
                results.append({
                    "target_user_id": target_user_id,
                    "shared_todo_id": shared_todo_id,
                    "success": False,
                    "error": "任务不存在（可能已被删除）"
                })

        except Exception as e:
            current_app.logger.exception(f"Failed to revoke share from {target_user_id}")
            failed_count += 1
            results.append({
                "target_user_id": target_user_id,
                "shared_todo_id": shared_todo_id,
                "success": False,
                "error": "服务器错误"
            })

    # 返回撤回结果
    if success_count == 0:
        return jsonify({
            "status": "error",
            "error": "所有撤回操作失败",
            "results": results
        }), 400
    else:
        return jsonify({
            "status": "ok",
            "msg": f"成功撤回 {success_count} 个分享" + (f"，失败 {failed_count} 个" if failed_count > 0 else ""),
            "success_count": success_count,
            "failed_count": failed_count,
            "results": results
        })


# ========= 分享历史管理（服务器端history.json） =========

def _get_history_file_path():
    """获取分享历史文件路径（与sofia.db同目录）"""
    db = _get_db()
    db_path = Path(db.db_path)
    history_path = db_path.parent / "history.json"
    return history_path

def _load_share_history():
    """加载所有用户的分享历史"""
    history_path = _get_history_file_path()
    
    if not history_path.exists():
        return {}
    
    try:
        with open(history_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        current_app.logger.error(f"[todo] Failed to load share history: {e}")
        return {}

def _save_share_history(history):
    """保存分享历史到history.json"""
    history_path = _get_history_file_path()
    
    try:
        with open(history_path, 'w', encoding='utf-8') as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        current_app.logger.error(f"[todo] Failed to save share history: {e}")
        return False

@todo_bp.route("/api/share/history/get", methods=["GET"])
@todo_bp.route("/todo/api/share/history/get", methods=["GET"])
def get_share_history():
    """获取指定任务的分享历史"""
    user_id = request.args.get("user_id", "").strip().lower()
    task_id = request.args.get("task_id", "").strip()
    
    if not user_id or not task_id:
        return jsonify({"error": "缺少user_id或task_id参数"}), 400
    
    # 加载分享历史
    all_history = _load_share_history()
    user_history = all_history.get(user_id, {})
    task_history = user_history.get(task_id)
    
    if task_history:
        return jsonify({
            "status": "ok",
            "history": task_history
        })
    else:
        return jsonify({
            "status": "ok",
            "history": None
        })

@todo_bp.route("/api/share/history/save", methods=["POST"])
@todo_bp.route("/todo/api/share/history/save", methods=["POST"])
def save_share_history():
    """保存分享历史"""
    try:
        data = request.get_json(force=True)
        user_id = data.get("user_id", "").strip().lower()
        task_id = data.get("task_id", "").strip()
        task_title = data.get("task_title", "").strip()
        share_records = data.get("share_records", [])
    except Exception as e:
        current_app.logger.error(f"[todo] Save share history - JSON parse error: {e}")
        return jsonify({"error": "请求体格式错误"}), 400
    
    if not user_id or not task_id:
        return jsonify({"error": "缺少user_id或task_id参数"}), 400
    
    if not isinstance(share_records, list) or len(share_records) == 0:
        return jsonify({"error": "无效的分享记录"}), 400
    
    # 加载现有历史
    all_history = _load_share_history()
    
    # 确保用户历史存在
    if user_id not in all_history:
        all_history[user_id] = {}
    
    # 保存任务的分享历史
    all_history[user_id][task_id] = {
        "task_id": task_id,
        "task_title": task_title,
        "share_time": int(time.time() * 1000),  # 毫秒时间戳
        "records": share_records
    }
    
    # 保存到文件
    if _save_share_history(all_history):
        return jsonify({
            "status": "ok",
            "msg": "分享历史已保存"
        })
    else:
        return jsonify({"error": "保存分享历史失败"}), 500

@todo_bp.route("/api/share/history/delete", methods=["POST"])
@todo_bp.route("/todo/api/share/history/delete", methods=["POST"])
def delete_share_history():
    """删除指定任务的分享历史"""
    try:
        data = request.get_json(force=True)
        user_id = data.get("user_id", "").strip().lower()
        task_id = data.get("task_id", "").strip()
    except Exception as e:
        current_app.logger.error(f"[todo] Delete share history - JSON parse error: {e}")
        return jsonify({"error": "请求体格式错误"}), 400
    
    if not user_id or not task_id:
        return jsonify({"error": "缺少user_id或task_id参数"}), 400
    
    # 加载现有历史
    all_history = _load_share_history()
    
    # 删除指定任务的历史
    if user_id in all_history and task_id in all_history[user_id]:
        del all_history[user_id][task_id]
        
        # 如果用户没有其他历史记录，删除用户条目
        if not all_history[user_id]:
            del all_history[user_id]
        
        # 保存到文件
        if _save_share_history(all_history):
            return jsonify({
                "status": "ok",
                "msg": "分享历史已删除"
            })
        else:
            return jsonify({"error": "删除分享历史失败"}), 500
    else:
        return jsonify({
            "status": "ok",
            "msg": "没有找到分享历史"
        })


@todo_bp.route("/api/register", methods=["POST"])
@todo_bp.route("/todo/api/register", methods=["POST"])
def register_user():
    """注册或验证用户ID，写入 users.json 并生成专属数据文件"""
    try:
        data = request.get_json(force=True)
        user_id = (data.get("user_id") or "").strip().lower()
    except Exception:
        return jsonify({"code": 403, "msg": "请求体错误，需包含 user_id"}), 403

    sanitized = _sanitize_user_id(user_id)
    if not sanitized:
        return jsonify({"code": 403, "msg": "user_id 无效，需为 8~64 位字母或数字"}), 403

    try:
        created = _ensure_user_registry_entry(sanitized)
        if created:
            # 新用户注册：创建系统欢迎任务
            welcome_task = _create_welcome_task()
            _save_payload(sanitized, {"items": [welcome_task], "preferences": {}})
        else:
            _ensure_payload_file(sanitized)
        return jsonify({"status": "ok", "user_id": sanitized, "created": created})
    except Exception:
        current_app.logger.exception("Failed to register todo user")
        return jsonify({"code": 500, "msg": "服务器内部错误，请稍后重试"}), 500


@todo_bp.route("/api/login", methods=["POST"])
@todo_bp.route("/todo/api/login", methods=["POST"])
def login_user():
    """校验用户是否已注册，仅做登录验证，不创建文件"""
    try:
        data = request.get_json(force=True)
        user_id = (data.get("user_id") or "").strip().lower()
    except Exception:
        return jsonify({"code": 403, "msg": "请求体错误，需包含 user_id"}), 403

    sanitized = _sanitize_user_id(user_id)
    if not sanitized:
        return jsonify({"code": 403, "msg": "user_id 无效，需为 8~64 位字母或数字"}), 403

    try:
        exists = _user_exists(sanitized)
        if exists:
            _ensure_payload_file(sanitized)
        return jsonify(
            {"status": "ok", "user_id": sanitized, "exists": bool(exists)}
        )
    except Exception:
        current_app.logger.exception("Failed to validate todo user")
        return jsonify({"code": 500, "msg": "服务器内部错误，请稍后重试"}), 500

# ========= 内部函数 =========

def _payload_path(user_id: str) -> Path:
    """每个用户对应一个独立 todo 文件，目录名按你的说法使用 todo_data"""
    storage_dir = _storage_root()
    return storage_dir / f"todos-{user_id}.json"

def _load_payload(user_id: str) -> dict:
    """加载用户数据（SQLite模式）- 包含个人任务和协作任务"""
    try:
        db = _get_db()
        # 获取个人任务
        personal_todos = db.get_user_todos(user_id)
        for todo in personal_todos:
            todo['isCollaborative'] = False

        # 获取协作任务
        collaborative_todos = db.get_collaborative_todos(user_id)

        # 合并返回
        all_todos = personal_todos + collaborative_todos
        return {
            "items": all_todos,
            "preferences": {}
        }
    except Exception as e:
        print(f"[SQLite] 加载用户 {user_id} 数据失败: {e}")
        return {"items": [], "preferences": {}}

def _save_payload(user_id: str, payload: dict) -> None:
    """保存用户数据（SQLite模式）- 区分个人任务和协作任务"""
    db = _get_db()
    items = payload.get("items", [])

    # 分离个人任务和协作任务
    personal_items = []
    collaborative_items = []

    for item in items:
        if item.get('isCollaborative'):
            collaborative_items.append(item)
        else:
            personal_items.append(item)

    print(f"[Save] User {user_id}: {len(personal_items)} personal, {len(collaborative_items)} collaborative")

    # 保存个人任务（完全替换）
    try:
        db.save_user_todos(user_id, personal_items)
    except Exception as e:
        print(f"[Save] Failed to save personal todos: {e}")
        raise

    # 更新协作任务（逐个更新，需验证权限）
    for item in collaborative_items:
        todo_id = item.get('id')
        if not todo_id:
            print(f"[Save] Skipped collaborative todo - no id")
            continue
        try:
            is_collab = db.is_collaborator(todo_id, user_id)
            print(f"[Save] Checking collaborator: todo={todo_id}, user={user_id}, is_collab={is_collab}")
            if is_collab:
                db.update_collaborative_todo(todo_id, item)
                print(f"[Save] Updated collaborative todo {todo_id}")
            else:
                print(f"[Save] Skipped collaborative todo {todo_id} - not a collaborator")
        except Exception as e:
            print(f"[Save] Failed to update collaborative todo {todo_id}: {e}")
            raise


def _ensure_payload_file(user_id: str) -> None:
    """确保用户记录存在（SQLite模式）"""
    try:
        db = _get_db()
        if not db.user_exists(user_id):
            # 用户不存在，这通常不应该发生（login 应该先检查）
            print(f"[SQLite] Warning: Ensuring payload for non-existent user: {user_id}")
            db.create_user(user_id)
    except Exception as e:
        print(f"[SQLite] Failed to ensure user {user_id}: {e}")

def _create_welcome_task() -> dict:
    """创建新用户的系统欢迎任务"""
    import uuid
    import time

    now = int(time.time() * 1000)

    # 简化版使用说明
    welcome_content = """# 👋 欢迎使用Sofia记事清单！

## 🚀 快速开始

### 添加任务
1. 点击"开始任务编辑"按钮
2. 输入任务标题（必填）和内容（可选，支持Markdown）
3. 设置开始时间和重复模式
4. 点击"添加任务"

### 管理任务
- ✅ **完成任务**：勾选任务前的复选框
- 📌 **置顶任务**：勾选置顶开关，重要任务始终在前
- ✏️ **编辑任务**：点击"编辑"按钮修改内容
- 🗑️ **删除任务**：点击"删除"按钮

---

## 🔄 重复任务

### 三种重复模式
- **不重复**：任务只执行一次
- **每日重复**：每天相同时间自动重复
- **自定义重复**：按小时数自定义间隔（可选每周、每月或自定义）

💡 **提示**：完成当天任务后，下一周期自动重置为待完成

---

## 🔗 任务分享

### 分享给好友
1. 点击任务的"分享"按钮
2. 输入对方的昵称或用户ID（推荐使用昵称）
3. 选择**署名分享**（默认）或**匿名分享**
4. 点击"确认分享"

### 署名vs匿名
- **署名分享**：对方看到 `[来自XXX分享] 任务标题`（推荐）
- **匿名分享**：对方看到 `任务标题`（隐藏身份）

### 多用户&广播分享
- **多用户**：一次最多选择3个用户
- **广播分享**：输入 `@all` 或 `@所有人` 分享给所有人

💡 **提示**：建议先设置昵称（双击底部"昵称"标签快速修改）

---

## 🏷️ 昵称系统

### 设置昵称
- **方式1**：双击底部"昵称"标签，直接修改
- **方式2**：长按（手机端）昵称标签编辑

### 昵称的好处
- ✅ 分享时更容易记忆（无需记住复杂ID）
- ✅ 署名分享时显示你的昵称
- ✅ 他人可通过昵称向你分享

---

## 🔍 筛选与搜索

### 筛选按钮
- **全部**：显示所有任务（可切换隐藏/显示已完成）
- **待完成**：只显示未完成的任务
- **已完成**：只显示已完成的任务

### 搜索功能
在搜索框输入关键词，支持多关键词搜索（空格分隔）

---

## 💾 数据管理

### 导出/导入
- **导出**：下载JSON备份文件
- **导入**：从JSON文件恢复数据
- **切换用户**：可在不同账号间切换

### 数据同步
- ✅ 自动保存到服务器
- ✅ 跨设备同步
- ✅ IndexedDB本地缓存

---

## 📱 界面技巧

### 折叠/展开
- 点击标题栏左侧的小三角，或直接点击整个标题栏
- 手机端：优化了单手操作体验

### Markdown支持
任务内容支持Markdown格式：
- `**粗体**` → **粗体**
- `*斜体*` → *斜体*
- `- 列表项` → 项目符号
- `[链接](url)` → 可点击链接

---

## 🎯 使用建议

1. **设置昵称**：方便分享和协作
2. **置顶重要任务**：今天必须完成的任务置顶
3. **合理使用重复**：日常习惯用每日重复，长期计划用自定义重复
4. **善用分享**：团队协作时选择署名分享，匿名建议时选择匿名分享
5. **定期导出备份**：养成备份习惯，数据更安全

---

## 📚 更多帮助

点击底部的"帮助"链接查看完整使用文档

---

**🎉 祝您使用愉快！开始创建您的第一个任务吧！**

_© 2025 枫中数智化研发组 | Sofia记事清单 v1.8.2_"""

    return {
        "id": str(uuid.uuid4()),
        "title": "【来自系统信息】Sofia记事清单使用说明",
        "content": welcome_content,
        "completed": False,
        "pinned": True,  # 置顶显示
        "startAt": now,
        "repeatDaily": False,
        "repeatConfig": {"mode": "none", "hours": 0},
        "createdAt": now,
        "updatedAt": now,
    }

def _extract_user_id() -> str:
    return "localuser"

def _sanitize_user_id(value):
    if not value or not isinstance(value, str):
        return None
    value = value.strip().lower()
    if not (8 <= len(value) <= 64):
        return None
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789")
    if any(ch not in allowed for ch in value):
        return None
    return value


def _storage_root() -> Path:
    """Resolve a writable directory for todo storage."""
    configured = current_app.config.get("TODO_STORAGE_DIR")
    if configured:
        root = Path(configured)
    else:
        root = Path(current_app.instance_path) / "todo_data"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _users_file() -> Path:
    """返回新用户数据文件路径（new_users.json）"""
    return _storage_root() / "new_users.json"


def _load_user_registry(path: Path) -> list:
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, list):
            return []
        return [
            entry.strip().lower()
            for entry in data
            if isinstance(entry, str) and _sanitize_user_id(entry)
        ]
    except Exception:
        current_app.logger.exception("Failed to load todo user registry")
        return []


def _write_user_registry(path: Path, users: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(users, fh, ensure_ascii=False, indent=2)
    tmp.replace(path)


def _ensure_user_registry_entry(user_id: str) -> bool:
    """确保用户在注册表中（SQLite模式）"""
    try:
        db = _get_db()
        return db.create_user(user_id)  # 返回 True 表示新建，False 表示已存在
    except Exception as e:
        print(f"[SQLite] Failed to register user {user_id}: {e}")
        raise


def _user_exists(user_id: str) -> bool:
    """检查用户是否存在（SQLite模式）"""
    try:
        db = _get_db()
        return db.user_exists(user_id)
    except Exception as e:
        print(f"[SQLite] 检查用户 {user_id} 失败: {e}")
        return False


# ========= 用户资料相关函数 =========

def _load_user_profiles() -> dict:
    """加载用户资料（SQLite模式）"""
    try:
        db = _get_db()
        users = db.get_all_users()
        # 转换为字典格式 {user_id: user_data}
        profiles = {}
        for user in users:
            profiles[user['user_id']] = {
                "user_id": user['user_id'],
                "nickname": user.get('nickname', ''),
                "created_at": user.get('created_at', 0),
                "updated_at": user.get('updated_at', 0)
            }
        return profiles
    except Exception as e:
        print(f"[SQLite] 加载用户列表失败: {e}")
        return {}


def _save_user_profiles(profiles: dict) -> None:
    """保存用户资料（SQLite模式）"""
    try:
        db = _get_db()
        for user_id, profile in profiles.items():
            db.create_or_update_user(
                user_id,
                profile.get('nickname', ''),
                profile.get('created_at'),
                profile.get('updated_at')
            )
    except Exception as e:
        print(f"[SQLite] 保存用户资料失败: {e}")
        raise


def _get_user_profile(user_id: str) -> dict:
    """获取单个用户资料"""
    try:
        db = _get_db()
        return db.get_user_profile(user_id)
    except Exception as e:
        print(f"[SQLite] 获取用户资料失败: {e}")
        return None


def _find_user_by_id_or_nickname(identifier: str) -> tuple:
    """
    根据用户ID或昵称查找用户

    Args:
        identifier: 用户ID或昵称

    Returns:
        tuple: (user_id, nickname) 如果找到；(None, None) 如果未找到
    """
    if not identifier:
        return None, None

    profiles = _load_user_profiles()
    return _find_user_in_profiles(identifier, profiles)


def _find_user_in_profiles(identifier: str, profiles: dict) -> tuple:
    """
    在预加载的用户资料中查找用户（优化版本，避免重复加载文件）

    Args:
        identifier: 用户ID或昵称
        profiles: 预加载的用户资料字典

    Returns:
        tuple: (user_id, nickname) 如果找到；(None, None) 如果未找到
    """
    if not identifier:
        return None, None

    identifier_lower = identifier.strip().lower()

    # 1. 首先尝试作为用户ID查找（精确匹配）
    if identifier_lower in profiles:
        profile = profiles[identifier_lower]
        return identifier_lower, profile.get("nickname", "")

    # 2. 尝试作为昵称查找（不区分大小写）
    for user_id, profile in profiles.items():
        nickname = profile.get("nickname", "")
        if nickname and nickname.lower() == identifier_lower:
            return user_id, nickname

    # 3. 未找到
    return None, None


# ========= 用户资料相关路由 =========

@todo_bp.route("/api/profile", methods=["GET"])
@todo_bp.route("/todo/api/profile", methods=["GET"])
def get_user_profile():
    """获取用户资料（包括昵称）"""
    try:
        user_id = _extract_user_id()
    except BadRequest:
        return jsonify({"code": 403, "msg": "缺少user_id参数"}), 403

    if not _user_exists(user_id):
        return jsonify({"code": 404, "msg": "用户不存在"}), 404

    try:
        profile = _get_user_profile(user_id)
        if not profile:
            # 用户存在但没有资料，创建默认资料
            import time
            profile = {
                "user_id": user_id,
                "nickname": "",
                "created_at": int(time.time() * 1000),
                "updated_at": int(time.time() * 1000)
            }

        return jsonify({
            "status": "ok",
            "user_id": profile.get("user_id", user_id),
            "nickname": profile.get("nickname", ""),
            "created_at": profile.get("created_at", 0),
            "updated_at": profile.get("updated_at", 0)
        })
    except Exception:
        current_app.logger.exception("Failed to get user profile")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


@todo_bp.route("/api/nickname", methods=["PUT"])
@todo_bp.route("/todo/api/nickname", methods=["PUT"])
def update_nickname():
    """更新用户昵称（SQLite模式）"""
    try:
        user_id = _extract_user_id()
    except BadRequest:
        return jsonify({"code": 403, "msg": "缺少user_id参数"}), 403

    if not _user_exists(user_id):
        return jsonify({"code": 404, "msg": "用户不存在"}), 404

    try:
        data = request.get_json(force=True)
        nickname = data.get("nickname", "").strip()

        # 昵称验证
        if not nickname:
            return jsonify({"code": 400, "msg": "昵称不能为空"}), 400

        if len(nickname) > 32:
            return jsonify({"code": 400, "msg": "昵称长度不能超过32个字符"}), 400

        # 更新昵称（SQLite模式）
        db = _get_db()
        db.update_user_nickname(user_id, nickname)

        return jsonify({
            "status": "ok",
            "nickname": nickname,
            "msg": "昵称更新成功"
        })
    except BadRequest:
        return jsonify({"code": 400, "msg": "请求体格式错误"}), 400
    except Exception:
        current_app.logger.exception("Failed to update nickname")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


@todo_bp.route("/api/user/search", methods=["GET"])
@todo_bp.route("/todo/api/user/search", methods=["GET"])
def search_user():
    """搜索用户（通过昵称或ID）"""
    query = request.args.get("q", "").strip().lower()

    # 允许空查询返回所有用户（用于分享对话框加载用户列表）
    if not query:
        try:
            profiles = _load_user_profiles()
            results = []
            for user_id, profile in profiles.items():
                results.append({
                    "user_id": user_id,
                    "nickname": profile.get("nickname", "")
                })
            return jsonify({
                "status": "ok",
                "results": results,
                "count": len(results)
            })
        except Exception:
            current_app.logger.exception("Failed to load all users")
            return jsonify({"code": 500, "msg": "服务器错误"}), 500

    if len(query) < 2:
        return jsonify({"code": 400, "msg": "搜索关键词至少2个字符"}), 400

    try:
        profiles = _load_user_profiles()
        results = []

        for user_id, profile in profiles.items():
            nickname = profile.get("nickname", "")

            # 匹配昵称或ID
            if query in nickname.lower() or query in user_id.lower():
                results.append({
                    "user_id": user_id,
                    "nickname": nickname
                })

            # 限制返回结果数量
            if len(results) >= 10:
                break

        return jsonify({
            "status": "ok",
            "results": results,
            "count": len(results)
        })
    except Exception:
        current_app.logger.exception("Failed to search user")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


# ========= 管理员相关路由 =========

@todo_bp.route("/api/admin/login", methods=["POST"])
@todo_bp.route("/todo/api/admin/login", methods=["POST"])
def admin_login():
    """管理员登录"""
    try:
        data = request.get_json(force=True)
        password = data.get("password", "").strip()
    except Exception:
        return jsonify({"code": 400, "msg": "请求体错误"}), 400

    if not password:
        return jsonify({"code": 400, "msg": "密码不能为空"}), 400

    admin_password = _get_admin_password()
    if password == admin_password:
        session['is_admin'] = True
        return jsonify({"status": "ok", "msg": "登录成功"})
    else:
        return jsonify({"code": 401, "msg": "密码错误"}), 401


@todo_bp.route("/api/admin/logout", methods=["POST"])
@todo_bp.route("/todo/api/admin/logout", methods=["POST"])
def admin_logout():
    """管理员登出"""
    session.pop('is_admin', None)
    return jsonify({"status": "ok", "msg": "已登出"})


@todo_bp.route("/api/admin/users", methods=["GET"])
@todo_bp.route("/todo/api/admin/users", methods=["GET"])
@admin_required
def get_all_users():
    """获取所有用户列表及其任务数"""
    try:
        profiles = _load_user_profiles()
        user_list = []

        for user_id, profile in profiles.items():
            payload = _load_payload(user_id)
            items = payload.get("items", [])
            user_list.append({
                "user_id": user_id,
                "nickname": profile.get("nickname", ""),
                "task_count": len(items),
                "completed_count": len([item for item in items if item.get("completed")]),
                "created_at": profile.get("created_at", 0)
            })

        return jsonify({"status": "ok", "users": user_list})
    except Exception as e:
        current_app.logger.exception("Failed to get users list")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


@todo_bp.route("/api/admin/users/<user_id>", methods=["DELETE"])
@todo_bp.route("/todo/api/admin/users/<user_id>", methods=["DELETE"])
@admin_required
def delete_user(user_id):
    """删除用户及其所有任务"""
    try:
        sanitized = _sanitize_user_id(user_id)
        if not sanitized:
            return jsonify({"code": 400, "msg": "无效的用户ID"}), 400

        # 删除用户（SQLite会自动级联删除任务）
        db = _get_db()
        success = db.delete_user(sanitized)

        if success:
            return jsonify({"status": "ok", "msg": "用户已删除"})
        else:
            return jsonify({"code": 404, "msg": "用户不存在"}), 404

    except Exception as e:
        current_app.logger.exception("Failed to delete user")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


@todo_bp.route("/api/admin/users", methods=["POST"])
@todo_bp.route("/todo/api/admin/users", methods=["POST"])
@admin_required
def create_user():
    """管理员创建新用户"""
    try:
        data = request.get_json(force=True)
        user_id = (data.get("user_id") or "").strip().lower()
        nickname = (data.get("nickname") or "").strip()
    except Exception:
        return jsonify({"code": 400, "msg": "请求体错误"}), 400

    # 验证用户ID
    sanitized = _sanitize_user_id(user_id)
    if not sanitized:
        return jsonify({"code": 400, "msg": "用户ID无效，需为8~64位字母或数字"}), 400

    # 验证昵称
    if nickname and len(nickname) > 32:
        return jsonify({"code": 400, "msg": "昵称长度不能超过32个字符"}), 400

    try:
        # 检查用户是否已存在
        if _user_exists(sanitized):
            return jsonify({"code": 400, "msg": "用户ID已存在"}), 400

        # 创建用户（SQLite模式）
        db = _get_db()
        db.create_user(sanitized, nickname)

        # 创建用户数据文件
        _save_payload(sanitized, {"items": [], "preferences": {}})

        return jsonify({
            "status": "ok",
            "msg": "用户创建成功",
            "user_id": sanitized,
            "nickname": nickname
        })
    except Exception:
        current_app.logger.exception("Failed to create user")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


@todo_bp.route("/api/admin/users/<user_id>", methods=["PUT"])
@todo_bp.route("/todo/api/admin/users/<user_id>", methods=["PUT"])
@admin_required
def update_user(user_id):
    """管理员更新用户信息"""
    try:
        data = request.get_json(force=True)
        nickname = data.get("nickname", "").strip()
    except Exception:
        return jsonify({"code": 400, "msg": "请求体错误"}), 400

    # 验证用户ID
    sanitized = _sanitize_user_id(user_id)
    if not sanitized:
        return jsonify({"code": 400, "msg": "无效的用户ID"}), 400

    # 验证昵称
    if nickname and len(nickname) > 32:
        return jsonify({"code": 400, "msg": "昵称长度不能超过32个字符"}), 400

    try:
        # 检查用户是否存在
        if not _user_exists(sanitized):
            return jsonify({"code": 404, "msg": "用户不存在"}), 404

        # 更新用户信息（SQLite模式）
        db = _get_db()
        db.update_user_nickname(sanitized, nickname)

        return jsonify({
            "status": "ok",
            "msg": "用户信息更新成功",
            "user_id": sanitized,
            "nickname": nickname
        })
    except Exception:
        current_app.logger.exception("Failed to update user")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


@todo_bp.route("/api/admin/users/<user_id>/view", methods=["GET"])
@todo_bp.route("/todo/api/admin/users/<user_id>/view", methods=["GET"])
@admin_required
def view_user_data(user_id):
    """管理员浏览用户数据"""
    try:
        sanitized = _sanitize_user_id(user_id)
        if not sanitized:
            return jsonify({"code": 400, "msg": "无效的用户ID"}), 400

        # 检查用户是否存在
        if not _user_exists(sanitized):
            return jsonify({"code": 404, "msg": "用户不存在"}), 404

        # 加载用户资料
        profiles = _load_user_profiles()
        user_profile = profiles.get(sanitized, {})

        # 加载用户任务数据
        payload = _load_payload(sanitized)
        items = payload.get("items", [])

        return jsonify({
            "status": "ok",
            "user_id": sanitized,
            "nickname": user_profile.get("nickname", ""),
            "created_at": user_profile.get("created_at", None),
            "tasks": items
        })
    except Exception:
        current_app.logger.exception("Failed to view user data")
        return jsonify({"code": 500, "msg": "服务器错误"}), 500


# 导入附件管理路由
from . import routes_attachments  # noqa: F401

