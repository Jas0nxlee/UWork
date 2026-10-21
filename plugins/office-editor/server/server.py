#!/usr/bin/env python3
"""office-editor 插件的 MCP stdio 服务器（纯标准库，无第三方依赖）。

协议面：``initialize`` / ``notifications/initialized`` / ``ping`` / ``tools/list`` / ``tools/call`` /
``resources/list`` / ``resources/templates/list`` / ``resources/read``。stdout 只输出 JSON-RPC 帧，日志一律走 stderr。

页面装配：``resources/read`` 时把官方 ext-apps 浏览器 bundle、docx-preview（Apache-2.0）、JSZip 与
``ui/page.js`` 内联进 ``ui/editor.html``（单文件页面，宿主按 ``ui://`` 资源承载）。三个 bundle 各自包进
IIFE 只解构出导出（``App`` / ``renderAsync`` …）——同一个 module 作用域里内联多个 minified bundle，
顶层单字母变量会互相冲撞，整段脚本 SyntaxError（真机表现：页面能加载但 ``ui/initialize`` 永远握不上手）。
docx-preview 的裸导入 ``import e from"jszip"`` 内联前改写成对上面 IIFE 里 ``JSZip`` 的引用。

文档字节通道（页面无文件系统原语）：``office://docx?path=…`` 分块读。宿主对页面读资源的单次上限是
8 MiB 解码，但真正的天花板是 vendored MCP SDK 的 stdio 帧 10 MiB（base64 膨胀 4/3），所以按 4 MiB 分块；
``meta=1`` 返回 ``{size, mtimeNs, etag, chunkBytes, chunks}`` 供页面决定读几块与是否需要重读；\n``office://docx/paragraphs`` 给段号清单，供编辑页把渲染出的 ``<p>`` 对回引擎段号。
"""

from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
import json
import os
import re
import stat
import sys
import traceback
import urllib.parse
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from docx_revisions import (  # noqa: E402
    DEFAULT_PAGE_SIZE,
    MAX_WRITE_BACK_BASE64_BYTES,
    document_etag,
    edit_paragraph,
    list_comments,
    list_paragraphs,
    list_revisions,
    revision_counts,
    revision_marks,
    resolve_revisions,
    set_paragraph_format,
    write_back,
)
from docx_package import validate_archive  # noqa: E402

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_DIR = os.path.join(PLUGIN_ROOT, "ui")
VENDOR_BUNDLE = os.path.join(UI_DIR, "vendor", "mcp-apps-app.js")
SUPERDOC_JS = os.path.join(UI_DIR, "vendor", "superdoc", "superdoc.min.js")
SUPERDOC_CSS = os.path.join(UI_DIR, "vendor", "superdoc", "superdoc.min.css")
ENGINE_CONFIG_PATH = os.path.join(PLUGIN_ROOT, "engine.json")
SUPERDOC_CONFIG_URI = "office://superdoc/config"
DOCX_RESOURCE_URI = "office://docx"
BLOB_MIME = "application/octet-stream"
META_MIME = "application/json"
# 解码后 4 MiB：base64 膨胀到 ≈5.33 MiB，距宿主 8 MiB 与 SDK stdio 帧 10 MiB 都有余量。
CHUNK_MAX_BYTES = 4 * 1024 * 1024
PAGE_URI = "ui://office-editor/editor.html"
PAGE_MIME = "text/html;profile=mcp-app"
SERVER_INFO = {"name": "office-editor", "version": "0.1.0"}
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_PROTOCOL_VERSION = "2024-11-05"

def engine_config() -> dict:
    """内网引擎镜像配置（engine.json）。留空 baseUrl 时编辑器不可用，页面回落只读预览。"""
    try:
        with open(ENGINE_CONFIG_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        log(f"engine.json 读取失败：{error}")
        return {"baseUrl": "", "engineVersion": ""}
    base = str(data.get("baseUrl") or "").strip().rstrip("/")
    return {"baseUrl": base, "engineVersion": str(data.get("engineVersion") or "")}


def _open_editor_ui_marshal() -> dict:
    """docx_open_editor 的 _meta.ui：配置了内网引擎镜像时放行该域名。

    工具描述是每次 tools/list 现算的，所以改 engine.json 后冷启动即可生效（无需改代码）。
    """
    ui = {
        "resourceUri": PAGE_URI,
        "preferredDisplayMode": "fullscreen",
        "csp": {},
    }
    base = engine_config()["baseUrl"]
    if base.startswith("http://") or base.startswith("https://"):
        origin = "/".join(base.split("/")[:3])
        ui["csp"]["connectDomains"] = [origin]
        ui["csp"]["resourceDomains"] = [origin]
    return ui


def page_resource_meta() -> dict:
    # 宿主只认 HTML 资源自己的 zcode/csp；把 unsafeEval 写进工具 ui.csp 会被归一化丢弃。
    return {"ui": {"csp": _open_editor_ui_marshal()["csp"]}, "zcode/csp": {"unsafeEval": True}}


TOOLS = [
    {
        "name": "docx_revisions_list",
        "title": "列出 Word 修订",
        "description": "分页列出 DOCX 里的修订（w:ins/w:del）：总数始终全量返回，条目按页取（大文档必需）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "工作区内的 .docx 绝对路径"},
                "offset": {"type": "integer", "description": "起始序号（默认 0）"},
                "limit": {"type": "integer", "description": f"每页条数（默认 {DEFAULT_PAGE_SIZE}，上限 100）"},
                "kind": {"type": "string", "enum": ["insert", "delete"], "description": "只看插入或删除"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "docx_comments_list",
        "title": "列出 Word 批注",
        "description": "分页列出 DOCX 批注（只读）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer"},
                "limit": {"type": "integer"},
            },
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
        "description": "在应用内承载插件页面：卡片里逐条接受/拒绝修订，侧栏大窗口里看文档与编辑。",
        # 宿主只从 tools/list 的 _meta 读取页面描述（apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts），
        # 放在调用结果上不会被识别——真机启动实测踩过这个坑。
        # preferredDisplayMode=fullscreen：卡片出现时自动把侧栏打开一次——审阅动作在卡片里做，
        # 真正的文档预览与编辑在侧边大窗口做（产品规则，见 specs/office-editor-plugin.md 二期）。
        "_meta": {"ui": _open_editor_ui_marshal()},
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "docx_edit_paragraph",
        "title": "编辑段落（默认修订模式）",
        "description": "把第 N 段改成给定文本。默认按修订模式落成 w:del + w:ins（公共前后缀保留），文档在 Word 里仍是未接受的修订；tracked=false 则直接改写。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "paragraph": {"type": "integer", "description": "段落序号（与列表工具同一口径，从 1 开始）"},
                "text": {"type": "string", "description": "该段的新文本"},
                "tracked": {"type": "boolean", "description": "默认 true＝留修订"},
                "author": {"type": "string", "description": "修订作者（默认「应用内编辑」）"},
            },
            "required": ["path", "paragraph", "text"],
        },
    },
    {
        "name": "docx_set_paragraph_format",
        "title": "设置段落格式",
        "description": "段落级格式：加粗/斜体/下划线（落到 w:rPr）与对齐（w:jc）。注意格式改动目前直接生效、不留修订。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "paragraph": {"type": "integer"},
                "bold": {"type": "boolean"},
                "italic": {"type": "boolean"},
                "underline": {"type": "boolean"},
                "align": {"type": "string", "enum": ["left", "center", "right", "justify"]},
            },
            "required": ["path", "paragraph"],
        },
    },
    {
        "name": "docx_current_target",
        "title": "当前审阅目标",
        "description": "返回本会话最近一次打开/列出的 Word 文件（页面挂载晚于工具结果时用它兜底）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "docx_write_back",
        "title": "写回整份 DOCX（编辑器保存）",
        "description": "把编辑器（侧栏的 Office 式编辑页）产出的整份 docx 覆盖原文件：校验 zip/document.xml、落备份、原子替换。data 是 base64。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "data": {"type": "string", "description": "整份 docx 的 base64"},
                "expectedEtag": {"type": "string", "description": "加载时从文档资源 meta 获取的 etag；冲突时须重载"},
            },
            "required": ["path", "data", "expectedEtag"],
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


# 最近一次被打开/列出的目标文件。同一 MCP server 进程只服务一个会话，所以页面可以用它兜底：
# 宿主是在工具完成后才挂载页面，`ontoolresult` 通知可能早于页面注册。
_last_target: dict | None = None
# 资源读不经过工具审批，不能把扩展名当授权。只登记成功工具调用访问过的真实文件身份。
_authorized_targets: dict[str, tuple[int, int]] = {}


def remember_target(path: str) -> dict:
    global _last_target
    real_path = os.path.realpath(os.path.expanduser(path))
    # 授权必须登记被解析的同一 fd 身份；先解析 path 再 realpath/stat 会把换向后的任意文件误授权。
    with _open_file_snapshot(real_path) as (handle, opened_stat):
        counts = revision_counts(path, source=handle, stat_result=opened_stat)
    _authorized_targets[real_path] = (opened_stat.st_dev, opened_stat.st_ino)
    _last_target = {
        "path": path,
        "fileName": os.path.basename(path),
        "counts": counts,
        "etag": document_etag(real_path, stat_result=opened_stat),
    }
    return _last_target


def log(message: str) -> None:
    print(f"[office-editor] {message}", file=sys.stderr, flush=True)


def _export_pairs(bundle: str) -> tuple[str, list]:
    """拆出 ESM 末尾的 ``export{a as b,…};``，返回 (去掉导出的正文, [(内部名, 对外名)…])。

    用「最后一个 export{」定位：bundle 末尾可能还跟着 ``//# sourceMappingURL=…`` 注释行
    （docx-preview 就是这样），用 ``$`` 锚点会漏判，导出语句就会原样留在 IIFE 里变成语法错误。
    """
    start = bundle.rfind("export{")
    if start == -1:
        return bundle, []
    match = re.match(r"export\{([^}]*)\};?", bundle[start:])
    if not match:
        return bundle, []
    pairs = []
    for item in match.group(1).split(","):
        item = item.strip()
        if not item:
            continue
        if " as " in item:
            internal, alias = (part.strip() for part in item.split(" as ", 1))
        else:
            internal = alias = item
        pairs.append((internal, alias))
    return bundle[:start], pairs


def _inline_esm(bundle: str, bare_imports: dict | None = None, only: set | None = None) -> str:
    """把 ESM bundle 包进 IIFE 并解构出它的导出（``only`` 限定只绑定用到的名字）。

    必须隔离：同一个 ``<script type="module">`` 里内联多个 minified bundle 时，
    顶层声明（``var t``/``function r`` 这类单字母名）会互相冲撞，整段脚本直接 SyntaxError，
    表现为页面能加载但永远握不上手（真机踩坑：plugin-ui: ui/initialize handshake timed out）。
    ``only`` 同时把「bundle 导出名 vs 页面自己的函数名」这类撞车挡在外面（docx-preview 也导出
    ``renderDocument``，页面里有同名函数就会 SyntaxError）。
    """
    body, pairs = _export_pairs(bundle)
    for specifier, global_name in (bare_imports or {}).items():
        pattern = re.compile(
            r"import\s+([A-Za-z_$][\w$]*)\s+from\s*[\"']" + re.escape(specifier) + r"[\"'];?"
        )
        body, count = pattern.subn(rf"const \1 = {global_name};", body)
        if count == 0:
            raise ValueError(f"内联失败：{specifier} 的裸导入未找到（库版本变了？）")
    if only is not None:
        pairs = [(internal, alias) for internal, alias in pairs if alias in only]
    if not pairs:
        return f"(() => {{\n{body}\n}})();"
    returns = ", ".join(f"{alias}: {internal}" for internal, alias in pairs)
    destructure = ", ".join(alias for _, alias in pairs)
    return f"const {{{destructure}}} = (() => {{\n{body}\nreturn {{{returns}}};\n}})();"


def _inline_umd(bundle: str, global_name: str) -> str:
    """把 UMD/全局式 bundle 包进 IIFE，并取它挂到 globalThis 上的名字（如 JSZip）。"""
    return (
        f"const {global_name} = (() => {{\n{bundle}\nreturn globalThis.{global_name};\n}})();"
    )


def read_page() -> bytes:
    with open(os.path.join(UI_DIR, "editor.html"), encoding="utf-8") as handle:
        template = handle.read()
    with open(SUPERDOC_CSS, encoding="utf-8") as handle:
        template = template.replace("<!--__STYLE__-->", f"<style>\n{handle.read()}\n</style>")
    with open(os.path.join(UI_DIR, "vendor", "jszip.min.js"), encoding="utf-8") as handle:
        jszip = _inline_umd(handle.read(), "JSZip")
    with open(os.path.join(UI_DIR, "vendor", "docx-preview.js"), encoding="utf-8") as handle:
        renderer = _inline_esm(handle.read(), {"jszip": "JSZip"}, only={"renderAsync"})
    with open(VENDOR_BUNDLE, encoding="utf-8") as handle:
        bridge = _inline_esm(handle.read(), only={"App"})
    with open(SUPERDOC_JS, encoding="utf-8") as handle:
        superdoc = handle.read()  # UMD：`var SuperDoc = …`，与控制台脚本同作用域即可直接用
    pages = []
    # 页面分段共享一个模块词法作用域与唯一 state，bootstrap 最后运行；不靠关闭 lint 容纳巨型文件。
    for name in ("page.js", "page_preview.js", "page_editor.js", "page_bootstrap.js"):
        with open(os.path.join(UI_DIR, name), encoding="utf-8") as handle:
            pages.append(handle.read())
    script = (
        '<script type="module">\n'
        + "\n".join([jszip, renderer, bridge, superdoc, *pages])
        + "\n</script>"
    )
    return template.replace("<!--__SCRIPT__-->", script).encode("utf-8")


def _readable_docx(raw_path: str) -> str:
    """页面只能读本进程中已经由成功工具调用登记的目标，不能借软链扩大授权。"""
    resolved = os.path.realpath(os.path.expanduser(raw_path or ""))
    if resolved not in _authorized_targets:
        raise ValueError("只允许读已通过工具打开且身份未变化的目标，请重新打开文档")
    return resolved


@contextmanager
def _open_file_snapshot(path: str, expected_identity: tuple[int, int] | None = None, expected_etag: str | None = None):
    """所有打开与授权共用的 fd 快照边界，不重复按路径读取。"""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError("目标已变化或无法安全打开，请重新打开文档") from error
    with os.fdopen(descriptor, "rb") as handle:
        before = os.fstat(handle.fileno())
        identity = (before.st_dev, before.st_ino)
        if not stat.S_ISREG(before.st_mode) or (expected_identity is not None and expected_identity != identity):
            raise ValueError("目标文件身份已变化，请重新打开文档")
        etag = document_etag(path, stat_result=before)
        if expected_etag is not None and expected_etag != etag:
            raise ValueError("文档版本已变化，请重新打开或重载文档")
        yield handle, before
        # fd 固定身份可防读错目标；前后版本与 lstat 再确认，拒绝读取期间的原地修改或路径替换。
        after = os.fstat(handle.fileno())
        try:
            path_after = os.stat(path, follow_symlinks=False)
        except OSError as error:
            raise ValueError("读取期间目标路径已变化，请重新打开文档") from error
        if (document_etag(path, stat_result=after) != etag
                or document_etag(path, stat_result=path_after) != etag):
            raise ValueError("读取期间文档已变化，请重新打开或重载文档")


@contextmanager
def _open_docx_resource(raw_path: str, expected_etag: str | None = None):
    """批准路径只解析一次；身份校验后的全部读取绑定同一 fd，不再次按路径打开。"""
    path = _readable_docx(raw_path)
    with _open_file_snapshot(path, _authorized_targets[path], expected_etag) as (handle, before):
        yield path, handle, before


def docx_resource_meta(path: str, *, stat_result: os.stat_result | None = None) -> dict:
    stat = stat_result if stat_result is not None else os.stat(path)
    return {
        "path": path,
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
        "etag": document_etag(path, stat_result=stat),
        "chunkBytes": CHUNK_MAX_BYTES,
        "chunks": max(1, -(-stat.st_size // CHUNK_MAX_BYTES)),
    }


def read_docx_resource(uri: str) -> dict:
    """``office://docx?path=…``：``meta=1`` 给元信息；``offset``/``length`` 给该段原始字节（base64 blob）。

    ``office://docx/marks?path=…`` 给紧凑修订标记（id/kind/文本前缀），供页面把渲染出的
    ``<ins>/<del>`` 与引擎条目对齐——渲染路径全程只走资源读，不触发工具审批。
    """
    parsed = urllib.parse.urlsplit(uri)
    query = urllib.parse.parse_qs(parsed.query)
    raw_path = (query.get("path") or [""])[0]
    expected_etag = (query.get("etag") or [None])[0]
    with _open_docx_resource(raw_path, expected_etag) as (path, handle, opened_stat):
        etag = document_etag(path, stat_result=opened_stat)
        if parsed.path in ("/marks", "/paragraphs"):
            with zipfile.ZipFile(handle) as archive:
                root, _xml = validate_archive(archive)
                payload = (revision_marks(path, root=root, etag=etag) if parsed.path == "/marks"
                           else list_paragraphs(path, root=root, etag=etag))
            return {"contents": [{"uri": uri, "mimeType": META_MIME, "text": json.dumps(payload, ensure_ascii=False)}]}
        if (query.get("meta") or ["0"])[0] not in ("", "0"):
            payload = json.dumps(docx_resource_meta(path, stat_result=opened_stat), ensure_ascii=False)
            return {"contents": [{"uri": uri, "mimeType": META_MIME, "text": payload}]}
        offset = max(0, int((query.get("offset") or ["0"])[0] or 0))
        length = int((query.get("length") or [str(CHUNK_MAX_BYTES)])[0] or CHUNK_MAX_BYTES)
        length = max(1, min(length, CHUNK_MAX_BYTES))
        handle.seek(offset)
        data = handle.read(length)
        log(f"docx chunk: offset={offset} bytes={len(data)}")
        return {"contents": [{"uri": uri, "mimeType": BLOB_MIME, "blob": base64.b64encode(data).decode("ascii")}]}


def _text(payload) -> list[dict]:
    return [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}]


def call_tool(name: str, arguments: dict) -> dict:
    if name == "docx_revisions_list":
        payload = list_revisions(
            arguments["path"],
            offset=int(arguments.get("offset") or 0),
            limit=int(arguments.get("limit") or DEFAULT_PAGE_SIZE),
            kind=arguments.get("kind"),
        )
        remember_target(arguments["path"])
        return {"content": _text(payload), "structuredContent": payload}
    if name == "docx_comments_list":
        payload = list_comments(
            arguments["path"],
            offset=int(arguments.get("offset") or 0),
            limit=int(arguments.get("limit") or DEFAULT_PAGE_SIZE),
        )
        remember_target(arguments["path"])
        return {"content": _text(payload), "structuredContent": payload}
    if name == "docx_revisions_resolve":
        result = resolve_revisions(
            arguments["path"], arguments["action"], arguments.get("ids")
        )
        remember_target(arguments["path"])
        return {"content": _text(result), "structuredContent": result}
    if name == "docx_edit_paragraph":
        result = edit_paragraph(
            arguments["path"],
            paragraph=int(arguments["paragraph"]),
            text=str(arguments.get("text") or ""),
            tracked=arguments.get("tracked") is not False,
            author=str(arguments.get("author") or "应用内编辑"),
        )
        remember_target(arguments["path"])
        return {"content": _text(result), "structuredContent": result}
    if name == "docx_set_paragraph_format":
        result = set_paragraph_format(
            arguments["path"],
            paragraph=int(arguments["paragraph"]),
            bold=arguments.get("bold"),
            italic=arguments.get("italic"),
            underline=arguments.get("underline"),
            align=arguments.get("align"),
        )
        remember_target(arguments["path"])
        return {"content": _text(result), "structuredContent": result}
    if name == "docx_open_editor":
        payload = remember_target(arguments["path"])
        return {
            "content": _text(payload),
            "structuredContent": payload,
            "_meta": {"ui": {"resourceUri": PAGE_URI}},
        }
    if name == "docx_write_back":
        raw = str(arguments.get("data") or "")
        if len(raw) > MAX_WRITE_BACK_BASE64_BYTES:
            raise ValueError(
                f"整份写回上限 {MAX_WRITE_BACK_BASE64_BYTES} base64 字节（6 MiB 文档）；暂不支持分块保存"
            )
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError(f"data 不是合法 base64: {error}") from error
        result = write_back(arguments["path"], data, str(arguments.get("expectedEtag") or ""))
        remember_target(arguments["path"])
        return {"content": _text(result), "structuredContent": result}
    if name == "docx_current_target":
        if _last_target is None:
            return {
                "content": [
                    {
                        "type": "text",
                        "text": "本会话还没有打开过 Word 文件：请先从对话里的工具卡片打开审阅视图。",
                    }
                ],
                "isError": True,
            }
        return {"content": _text(_last_target), "structuredContent": _last_target}
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
                    "_meta": page_resource_meta(),
                }
            ]
        }
    if method == "resources/templates/list":
        return {
            "resourceTemplates": [
                {
                    "uriTemplate": f"{DOCX_RESOURCE_URI}{{?path,offset,length,meta,etag}}",
                    "name": "DOCX 分块字节（页面渲染用）",
                    "mimeType": BLOB_MIME,
                },
                {
                    "uriTemplate": f"{DOCX_RESOURCE_URI}/marks{{?path,etag}}",
                    "name": "DOCX 修订标记（id/kind/文本，文档序）",
                    "mimeType": META_MIME,
                },
                {
                    "uriTemplate": f"{DOCX_RESOURCE_URI}/paragraphs{{?path,etag}}",
                    "name": "DOCX 段落清单（段号 + 文本前缀，编辑页用）",
                    "mimeType": META_MIME,
                },
            ]
        }
    if method == "resources/read":
        uri = params.get("uri") or ""
        if uri == SUPERDOC_CONFIG_URI:
            payload = json.dumps(engine_config(), ensure_ascii=False)
            return {"contents": [{"uri": uri, "mimeType": META_MIME, "text": payload}]}
        if uri.startswith(DOCX_RESOURCE_URI):
            return read_docx_resource(uri)
        if uri != PAGE_URI:
            raise ValueError(f"未知资源: {uri}")
        html = read_page()
        log(f"page assembled: {len(html)} bytes")
        return {"contents": [{"uri": PAGE_URI, "mimeType": PAGE_MIME, "text": html.decode("utf-8"), "_meta": page_resource_meta()}]}
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
