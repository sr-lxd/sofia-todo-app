# todo_app/__init__.py
import os
from flask import Flask, Blueprint, jsonify, request
from werkzeug.exceptions import BadRequest

# ==================== 版本配置 ====================
# 统一管理静态资源版本号，修改此处即可全局更新
__version__ = "3.0.0"  # 修复 updateAttachmentCount 未定义错误
STATIC_VERSION = __version__  # 静态资源版本号（CSS、JS等）

# 定义蓝图（不要在这里加 url_prefix）
todo_bp = Blueprint(
    "todo",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)

# 导入 routes 注册路由
from . import routes  # noqa: E402,F401


def create_app():
    app = Flask(__name__, instance_relative_config=True, instance_path=os.path.join(os.path.dirname(__file__), "instance"))
    os.makedirs(app.instance_path, exist_ok=True)
    app.config["TODO_STORAGE_DIR"] = os.path.join(app.instance_path, "todo_data")
    app.config["MAX_CONTENT_LENGTH"] = 233 * 1024 * 1024

    @app.errorhandler(BadRequest)
    def handle_bad_request(e):
        return jsonify({"error": str(e.description) if e.description else "请求格式错误"}), 400

    @app.before_request
    def disable_multi_user_features():
        path = request.path
        while path.startswith("/todo/"):
            path = path[len("/todo"): ]
        disabled = (
            "/api/login", "/api/register", "/api/admin",
            "/api/user/search", "/api/collaborate",
            "/api/items/share", "/api/share",
            "/collaborate",
        )
        if any(path == prefix or path.startswith(prefix + "/") for prefix in disabled):
            return jsonify({"error": "此版本为单机单用户版，该功能已停用"}), 404

    app.register_blueprint(todo_bp, url_prefix="/todo")

    with app.app_context():
        from .routes import _get_db
        db = _get_db()
        if not db.user_exists("localuser"):
            db.create_user("localuser", "本机用户")

    return app
