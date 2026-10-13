#!/usr/bin/env python3
"""office-editor 插件的 MCP stdio 服务器（纯标准库，无第三方依赖）。

协议面：``initialize`` / ``notifications/initialized`` / ``ping`` / ``tools/list`` / ``tools/call`` /
``resources/list`` / ``resources/read``。stdout 只输出 JSON-RPC 帧，日志一律走 stderr。

页面装配：``resources/read`` 时把官方 ext-apps 浏览器 bundle 与 ``ui/page.js`` 内联进
``ui/editor.html``（单文件页面，宿主按 ``ui://`` 资源承载）。bundle 是 ESM，末尾形如
``export{X as App,...};`` —— 内联前把该语句改写成 ``const App = X;`` 形式的别名，页面代码即可直接用 ``App``。
"""

from __future__ import annotations

import json
import os
import re
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from docx_revisions import list_revisions, resolve_revisions  # noqa: E402

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_DIR = os.path.join(PLUGIN_ROOT, "ui")
VENDOR_BUNDLE = os.path.join(UI_DIR, "vendor", "mcp-apps-app.js")
PAGE_URI = "ui://office-editor/editor.html"
PAGE_MIME = "text/html;profile=mcp-app"
SERVER_INFO = {"name": "office-editor", "version": "0.1.0"}
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "docx_revisions_list",
        "title": "列出 Word 修订",
        "description": "列出 DOCX 里的修订（w:ins/w:del）与批注（只读）。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "工作区内的 .docx 绝对路径"}},
            "required": ["path"],
        },
    },
    {
        "name": "docx_revisions_resolve",
        "title": "接受/拒绝 Word 修订",
        "description": "接受或拒绝修订：accept 保留插入文字并丢弃删除内容；reject 反之。原地写前先备份，写回是原子替换。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "action": {"type": "string", "enum": ["accept", "reject"]},
                "ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "要处理的修订 id（w:id）；省略表示全部",
                },
            },
            "required": ["path", "action"],
        },
    },
    {
        "name": "docx_open_editor",
        "title": "在应用内打开 Word 修订审阅",
        "description": "在应用内承载插件页面，用于逐条接受/拒绝修订。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "docx_export_pdf",
        "title": "导出 PDF（未实现）",
        "description": "首期未实现：需要 LibreOffice/soffice 转换链路。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
]


def log(message: str) -> None:
    print(f"[office-editor] {message}", file=sys.stderr, flush=True)


def _inline_module_aliases(bundle: str) -> str:
    """把 ESM 末尾的 ``export{...}`` 改写成 ``const <别名> = <内部名>;``，使内联脚本可直接引用。"""
    match = re.search(r"export\{([^}]*)\};?\s*$", bundle)
    if not match:
        return bundle
    aliases = []
    for item in match.group(1).split(","):
        item = item.strip()
        if not item:
            continue
        if " as " in item:
            internal, alias = (part.strip() for part in item.split(" as ", 1))
        else:
            continue  # 未改名的导出本身就在模块作用域内
        aliases.append(f"const {alias} = {internal};")
    return bundle[: match.start()] + "\n".join(aliases) + "\n"


def read_page() -> bytes:
    with open(os.path.join(UI_DIR, "editor.html"), encoding="utf-8") as handle:
        template = handle.read()
    with open(VENDOR_BUNDLE, encoding="utf-8") as handle:
        vendor = _inline_module_aliases(handle.read())
    with open(os.path.join(UI_DIR, "page.js"), encoding="utf-8") as handle:
        page = handle.read()
    script = f'<script type="module">\n{vendor}\n{page}\n</script>'
    return template.replace("<!--__SCRIPT__-->", script).encode("utf-8")


def _text(payload) -> list[dict]:
    return [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}]


def call_tool(name: str, arguments: dict) -> dict:
    if name == "docx_revisions_list":
        return {"content": _text(list_revisions(arguments["path"]))}
    if name == "docx_revisions_resolve":
        result = resolve_revisions(
            arguments["path"], arguments["action"], arguments.get("ids")
        )
        return {"content": _text(result), "structuredContent": result}
    if name == "docx_open_editor":
        path = arguments["path"]
        summary = list_revisions(path)
        payload = {
            "path": path,
            "fileName": os.path.basename(path),
            "counts": summary["counts"],
        }
        return {
            "content": _text(payload),
            "structuredContent": payload,
            "_meta": {"ui": {"resourceUri": PAGE_URI}},
        }
    if name == "docx_export_pdf":
        return {
            "content": [
                {
                    "type": "text",
                    "text": "未实现：DOCX→PDF 需要 LibreOffice/soffice 转换链路（P0.2 计划），本插件首期不提供。",
                }
            ],
            "isError": True,
        }
    raise ValueError(f"未知工具: {name}")


def handle_request(message: dict):
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        requested = params.get("protocolVersion")
        version = (
            requested if requested in SUPPORTED_PROTOCOL_VERSIONS else DEFAULT_PROTOCOL_VERSION
        )
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": SERVER_INFO,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        try:
            return call_tool(params["name"], params.get("arguments") or {})
        except Exception as error:  # 工具失败必须回 isError，而不是断开连接
            log(f"tool {params.get('name')} failed: {error}")
            return {
                "content": [{"type": "text", "text": f"{type(error).__name__}: {error}"}],
                "isError": True,
            }
    if method == "resources/list":
        return {
            "resources": [
                {
                    "uri": PAGE_URI,
                    "name": "office-editor 修订审阅",
                    "mimeType": PAGE_MIME,
                }
            ]
        }
    if method == "resources/read":
        uri = params.get("uri")
        if uri != PAGE_URI:
            raise ValueError(f"未知资源: {uri}")
        html = read_page()
        log(f"page assembled: {len(html)} bytes")
        return {"contents": [{"uri": PAGE_URI, "mimeType": PAGE_MIME, "text": html.decode("utf-8")}]}
    raise LookupError(f"Method not found: {method}")


def main() -> int:
    log(f"plugin root {PLUGIN_ROOT}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            log(f"bad frame: {error}")
            continue
        if message.get("method", "").startswith("notifications/"):
            continue  # 通知不需要响应
        message_id = message.get("id")
        if message_id is None:
            continue
        try:
            result = handle_request(message)
            response = {"jsonrpc": "2.0", "id": message_id, "result": result}
        except LookupError as error:
            response = {
                "jsonrpc": "2.0",
                "id": message_id,
                "error": {"code": -32601, "message": str(error)},
            }
        except Exception as error:  # noqa: BLE001
            log(traceback.format_exc())
            response = {
                "jsonrpc": "2.0",
                "id": message_id,
                "error": {"code": -32603, "message": f"{type(error).__name__}: {error}"},
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
