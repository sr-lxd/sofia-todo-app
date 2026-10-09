"""本机启动入口：仅监听 127.0.0.1。"""
import os
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

project_dir = Path(__file__).resolve().parent
spec = spec_from_file_location(
    "todo_app",
    project_dir / "__init__.py",
    submodule_search_locations=[str(project_dir)],
)
package = module_from_spec(spec)
sys.modules["todo_app"] = package
spec.loader.exec_module(package)
app = package.create_app()

if __name__ == "__main__":
    port = int(os.environ.get("TODO_PORT", "5052"))
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
