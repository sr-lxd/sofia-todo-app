# Sofia 记事清单（单机版）

<!-- en-intro -->
**Sofia Todo** — a local-first single-user todo app (Flask + SQLite) with Markdown notes, attachments, recurring tasks, search and filters.
<!-- /en-intro -->

---

基于 Flask 的本地记事与待办应用。此版本固定为一个本机用户，不需要注册、登录、用户 ID、远程后端或数据库。Flask 只监听 127.0.0.1，其他设备无法通过局域网访问。

## 功能

- 创建、编辑、完成、置顶和删除待办事项。
- 搜索、筛选待办事项，并按日期与置顶状态浏览。
- 设置开始日期和时间，支持每日重复与自定义重复间隔。
- 在事项内容中编写 Markdown 文本。
- 为事项上传、查看、下载和管理附件。
- 附件上传后保存在本机应用数据目录中。
- 浏览器界面主要使用项目内静态资源，不需要单独部署数据库服务器。Markdown 排版库从 CDN 加载；没有网络时，任务文字仍可查看和编辑。

## 环境要求

- Windows、macOS 或 Linux
- Python 3.9 或更新版本
- Flask（安装 requirements.txt 中的依赖）
- 现代浏览器

## 安装与启动

在项目目录打开 PowerShell 或终端：

    python -m venv .venv

Windows PowerShell：

    .venv\Scripts\Activate.ps1
    python -m pip install -r requirements.txt
    python app.py

macOS / Linux：

    source .venv/bin/activate
    python -m pip install -r requirements.txt
    python app.py

浏览器打开：

    http://127.0.0.1:5052/todo/

停止服务时，在运行 Flask 的终端按 Ctrl+C。

默认端口是 5052。如端口已被占用，可在启动前设置其他端口：

    $env:TODO_PORT = "5053"
    python app.py

服务仍然只绑定 127.0.0.1。

## 数据存储

应用使用 Python 自带的 SQLite，不需要安装或配置 MySQL。启动和使用时会在项目的 instance/ 目录创建本机数据：

- instance/todo.sqlite3：待办事项及应用关系数据。
- 首次使用附件功能后创建 instance/attachments.sqlite3：附件索引与元数据。
- instance/attachments/：实际上传的附件文件。

这些数据库和上传文件都被 .gitignore 排除，不会随源码提交。备份时先停止应用，然后复制整个 instance/ 目录；恢复时将其放回项目目录再启动。

原有 JSON 文件可以继续与 SQLite 并存，作为旧数据、导出文件或人工备份。单机版运行时以 SQLite 为活动数据源，不会自动扫描、导入或删除原有 JSON 文件。项目中的个人 JSON 数据与 SQLite 文件不提交到公开仓库。

## 项目结构

    todo_app/
    ├── app.py                  # 127.0.0.1 本机启动入口
    ├── __init__.py             # Flask 应用工厂与单用户设置
    ├── routes.py               # 页面、待办和本机 API
    ├── routes_attachments.py   # 附件 API
    ├── db_sqlite.py            # 待办 SQLite 数据访问
    ├── db_attachments.py       # 附件 SQLite 数据访问
    ├── schema.sql
    ├── schema_attachments.sql
    ├── requirements.txt
    ├── templates/
    └── static/

## 许可证

本项目原创程序代码按 MIT License 发布，见 LICENSE。随项目提供的思源黑体字体文件按 SIL Open Font License 1.1 单独授权，版权与许可文本见 static/fonts/LICENSE.txt。各许可证只适用于相应文件。
