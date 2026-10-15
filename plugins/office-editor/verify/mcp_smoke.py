#!/usr/bin/env python3
"""office-editor 冒烟测试：造样本（小样本 + 大文档），走 stdio JSON-RPC 驱动服务器。

覆盖：initialize / tools/list / tools/call（列修订、分页、批注、自举兜底、接受、拒绝）/ resources/*。
大文档部分同时验证"单次返回体必须在宿主的字节上限内"（content 32 KiB / structuredContent 64 KiB）。
只依赖标准库；样本写在临时目录，跑完即删。
"""

from __future__ import annotations

import atexit
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sample_fixture as fixture  # noqa: E402

PLUGIN_ROOT = os.path.dirname(HERE)
SERVER = os.path.join(PLUGIN_ROOT, "server", "server.py")
PAGE_URI = "ui://office-editor/editor.html"
DOCX_RESOURCE = "office://docx"
CHUNK_MAX_BYTES = 4 * 1024 * 1024
HOST_CONTENT_LIMIT_BYTES = 32 * 1024  # 宿主 tools/call content 上限
STDIO_FRAME_LIMIT_BYTES = 10 * 1024 * 1024  # vendored MCP SDK 的单帧上限（base64 膨胀后）
SAFETY_LIMIT_BYTES = 28 * 1024  # 我们自己的安全线


def build_sample(directory: str) -> str:
    return fixture.build_sample(directory)


def document_xml(path: str) -> str:
    return fixture.document_xml(path)


def unrelated_part(path: str) -> bytes:
    return fixture.unrelated_part(path)


class Server:
    def __init__(self) -> None:
        self.process = subprocess.Popen(
            [sys.executable, SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=PLUGIN_ROOT,
        )
        self.next_id = 1

    def rpc(self, method: str, params: dict | None = None) -> dict:
        request_id = self.next_id
        self.next_id += 1
        frame = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            frame["params"] = params
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(json.dumps(frame) + "\n")
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                stderr = self.process.stderr.read() if self.process.stderr else ""
                raise AssertionError(f"服务器提前退出，stderr:\n{stderr}")
            message = json.loads(line)
            if message.get("id") == request_id:
                if "error" in message:
                    raise AssertionError(f"{method} 返回错误: {message['error']}")
                return message["result"]

    def notify(self, method: str, params: dict | None = None) -> None:
        frame = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            frame["params"] = params
        assert self.process.stdin
        self.process.stdin.write(json.dumps(frame) + "\n")
        self.process.stdin.flush()

    def call(self, name: str, **arguments: object) -> dict:
        return self.rpc("tools/call", {"name": name, "arguments": arguments})

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        self.process.wait(timeout=10)


def payload(result: dict) -> dict:
    if "structuredContent" in result:
        return result["structuredContent"]
    return json.loads(result["content"][0]["text"])


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  {'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' — {detail}'}")
    if not condition:
        raise SystemExit(1)


def check_payload_size(label: str, value: dict) -> None:
    size = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    check(
        f"{label}（{size / 1024:.1f} KiB 在 {SAFETY_LIMIT_BYTES // 1024} KiB 安全线内）",
        size < SAFETY_LIMIT_BYTES,
        f"{size} bytes ≥ {HOST_CONTENT_LIMIT_BYTES}",
    )


def small_sample_checks(server: Server, path: str) -> None:
    print("修订读取（小样本）")
    listed = payload(server.call("docx_revisions_list", path=path))
    check(
        "样本有 1 插入 + 1 删除",
        listed["counts"] == {"insert": 1, "delete": 1, "comments": 0},
        str(listed["counts"]),
    )
    first, second = listed["items"]
    check("分页字段完整", listed["total"] == 2 and listed["hasMore"] is False, str(listed))
    check("修订带作者与文本", first["author"] == "审查员", str(first))
    # 审阅者要能判断"该不该接受"：位置（段/表）、最近标题、前后文缺一不可。
    check("修订带段落序号", first["paragraph"] == 2, str(first.get("paragraph")))
    check(
        "修订带最近标题",
        first["nearestHeading"] == {"text": "一、概述", "level": 1},
        str(first.get("nearestHeading")),
    )
    check(
        "插入的前后文正确",
        first["context"]["before"] == "第一段：" and first["context"]["after"].startswith("被删掉的旧句子。"),
        str(first.get("context")),
    )
    check(
        "删除的前后文包含插入文本",
        second["context"]["before"].endswith("插入的新句子。") and second["context"]["after"] == "尾段。",
        str(second.get("context")),
    )


def large_sample_checks(server: Server, path: str, counts: dict) -> None:
    print("大文档分页（" + ", ".join(f"{key}={value}" for key, value in counts.items()) + "）")
    started = time.time()
    page1 = payload(server.call("docx_revisions_list", path=path))
    first_parse_ms = (time.time() - started) * 1000
    check("总数与分布正确", page1["total"] == counts["insert"] + counts["delete"], str(page1["total"]))
    check(
        "总数含插入/删除分布",
        page1["counts"]
        == {"insert": counts["insert"], "delete": counts["delete"], "comments": counts["comments"]},
        str(page1["counts"]),
    )
    check("首屏取默认页大小", len(page1["items"]) == 25 and page1["hasMore"], f"{len(page1['items'])} 条")
    check_payload_size("首页返回体", page1)
    print(f"  （首次解析 + 首页 {first_parse_ms:.0f} ms）")

    started = time.time()
    page2 = payload(server.call("docx_revisions_list", path=path, offset=25, limit=25))
    page2_ms = (time.time() - started) * 1000
    check("第二页从第 26 条开始", page2["offset"] == 25 and len(page2["items"]) == 25, str(page2["offset"]))
    check("第二页条目与首页不同", page2["items"][0]["id"] != page1["items"][0]["id"])
    print(f"  （翻页（命中解析缓存）{page2_ms:.0f} ms）")

    capped = payload(server.call("docx_revisions_list", path=path, limit=100))
    check("每页上限被钳制", capped["limit"] == 40 and len(capped["items"]) == 40, str(capped["limit"]))
    check_payload_size("最大页返回体", capped)

    filtered = payload(server.call("docx_revisions_list", path=path, kind="delete", limit=25))
    check("按类型过滤只回删除", all(item["kind"] == "delete" for item in filtered["items"]), str(filtered["total"]))

    comments = payload(server.call("docx_comments_list", path=path, limit=25))
    check(
        "批注分页",
        comments["total"] == counts["comments"] and len(comments["items"]) == 25,
        str(comments["total"]),
    )
    check_payload_size("批注页返回体", comments)

    targets = [item["id"] for item in page1["items"][:5]]
    resolved = payload(server.call("docx_revisions_resolve", path=path, action="accept", ids=targets))
    check(
        "大文档上按 id 写回",
        resolved["processed"]["insert"] + resolved["processed"]["delete"] == 5,
        str(resolved["processed"]),
    )
    after = payload(server.call("docx_revisions_list", path=path))
    check("写回后计数减少", after["total"] == page1["total"] - 5, str(after["total"]))
    check("写回后有备份", os.path.exists(resolved["backup"]), str(resolved.get("backup")))


def main() -> int:
    directory = tempfile.mkdtemp(prefix="office-editor-smoke-")
    atexit.register(shutil.rmtree, directory, True)
    path = build_sample(directory)
    baseline_styles = unrelated_part(path)
    large_counts = {"insert": 200, "delete": 200, "comments": 60}
    large_path = fixture.build_large_sample(
        directory,
        paragraphs=600,
        inserts=large_counts["insert"],
        deletes=large_counts["delete"],
        comments=large_counts["comments"],
    )
    server = Server()
    try:
        print("协议面")
        init = server.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
        check("initialize 返回 serverInfo", init["serverInfo"]["name"] == "office-editor", str(init))
        check("回显受支持的协议版本", init["protocolVersion"] == "2025-06-18", init["protocolVersion"])
        server.notify("notifications/initialized")
        tools = server.rpc("tools/list")["tools"]
        names = {tool["name"] for tool in tools}
        check(
            "tools/list 暴露六个工具",
            names
            == {
                "docx_revisions_list",
                "docx_comments_list",
                "docx_revisions_resolve",
                "docx_open_editor",
                "docx_current_target",
                "docx_export_pdf",
            },
            str(names),
        )
        # 宿主只从 tools/list 的 _meta 读页面描述（adapters/src/mcp/descriptor.ts），
        # 放在调用结果上不会被识别——这条断言就是那次真机踩坑的回归。
        open_tool = next(tool for tool in tools if tool["name"] == "docx_open_editor")
        check(
            "docx_open_editor 的工具描述带 _meta.ui.resourceUri",
            open_tool.get("_meta", {}).get("ui", {}).get("resourceUri") == PAGE_URI,
            json.dumps(open_tool.get("_meta")),
        )

        small_sample_checks(server, path)
        large_sample_checks(server, large_path, large_counts)

        print("接受 / 拒绝（小样本语义）")
        accepted = payload(server.call("docx_revisions_resolve", path=path, action="accept", ids=["101"]))
        check("处理 1 条插入", accepted["processed"]["insert"] == 1, str(accepted))
        xml = document_xml(path)
        check("插入文字仍保留", "插入的新句子。" in xml and "w:ins" not in xml, xml[:200])
        check("删除文字尚未处理", "被删掉的旧句子。" in xml, xml[:200])
        check("无关部件逐字节保留", unrelated_part(path) == baseline_styles)
        rejected = payload(server.call("docx_revisions_resolve", path=path, action="reject"))
        check("处理 1 条删除", rejected["processed"]["delete"] == 1, str(rejected))
        xml = document_xml(path)
        check(
            "删除文字已恢复为正文",
            "<w:t>被删掉的旧句子。</w:t>" in xml and "w:delText" not in xml,
            xml[:300],
        )
        remaining = payload(server.call("docx_revisions_list", path=path))
        check(
            "修订清空",
            remaining["total"] == 0 and remaining["counts"] == {"insert": 0, "delete": 0, "comments": 0},
            str(remaining["counts"]),
        )

        print("未实现工具必须明确失败")
        exported = server.call("docx_export_pdf", path=path)
        check("export_pdf 返回 isError", exported.get("isError") is True, str(exported))

        print("页面自举兜底")
        current = payload(server.call("docx_current_target"))
        check("docx_current_target 返回最近目标", current.get("path") == path, json.dumps(current)[:160])

        print("页面资源")
        resources = server.rpc("resources/list")["resources"]
        check("暴露 editor 页面", resources[0]["uri"] == PAGE_URI, str(resources))
        check(
            "mime 带 mcp-app profile",
            resources[0]["mimeType"] == "text/html;profile=mcp-app",
            resources[0]["mimeType"],
        )
        page = server.rpc("resources/read", {"uri": PAGE_URI})["contents"][0]
        html = page["text"]
        check("页面含标题", "Word 修订审阅" in html, html[:120])
        check(
            "页面含分页与批注控件",
            all(marker in html for marker in ('id="pager"', 'id="comments"', 'id="totals"')),
            html[:200],
        )
        check("页面内联了 App 桥", "const App =" in html or "const App=" in html, html[:200])
        check("页面体积在宿主上限内", len(html.encode("utf-8")) < 16 * 1024 * 1024, str(len(html)))
        check(
            "页面内联了渲染器与 JSZip（裸导入已改写）",
            "renderAsync" in html and "JSZip" in html and 'from"jszip"' not in html,
            html[:200],
        )
        check(
            "页面体积在 stdio 帧上限内（base64 后再乘以 4/3 的余量）",
            len(html.encode("utf-8")) < STDIO_FRAME_LIMIT_BYTES // 2,
            str(len(html.encode("utf-8"))),
        )
        print(f"  页面大小 {len(html.encode('utf-8')) / 1024:.0f} KiB")

        print("文档字节通道（office://docx）")
        templates = server.rpc("resources/templates/list")["resourceTemplates"]
        check("声明字节与标记两个模板", len(templates) == 2, str([t["uriTemplate"] for t in templates]))
        meta = json.loads(
            server.rpc("resources/read", {"uri": f"{DOCX_RESOURCE}?path={path}&meta=1"})["contents"][0][
                "text"
            ]
        )
        size = os.path.getsize(path)
        check("meta 大小与磁盘一致", meta["size"] == size, f'{meta["size"]} != {size}')
        check(
            "meta 分块数自洽",
            meta["chunks"] == max(1, -(-size // meta["chunkBytes"])),
            json.dumps(meta),
        )
        with open(path, "rb") as handle:
            on_disk = handle.read()
        first = server.rpc(
            "resources/read", {"uri": f"{DOCX_RESOURCE}?path={path}&offset=0&length=2048"}
        )["contents"][0]
        second = server.rpc(
            "resources/read", {"uri": f"{DOCX_RESOURCE}?path={path}&offset=2048&length=2048"}
        )["contents"][0]
        check(
            "分块 mime 是 octet-stream",
            first["mimeType"] == "application/octet-stream",
            first["mimeType"],
        )
        merged = base64.b64decode(first["blob"]) + base64.b64decode(second["blob"])
        check("分块重组与磁盘字节逐字一致", merged == on_disk[:4096], f"len={len(merged)}")
        clamped = server.rpc(
            "resources/read",
            {"uri": f"{DOCX_RESOURCE}?path={path}&offset=0&length={64 * 1024 * 1024}"},
        )["contents"][0]
        clamped_len = len(base64.b64decode(clamped["blob"]))
        check(
            "超限长度被夹到 4 MiB",
            clamped_len == min(size, CHUNK_MAX_BYTES),
            f"{clamped_len} vs min({size}, {CHUNK_MAX_BYTES})",
        )
        marks = json.loads(
            server.rpc("resources/read", {"uri": f"{DOCX_RESOURCE}/marks?path={path}"})["contents"][0][
                "text"
            ]
        )
        wire_counts = payload(server.call("docx_revisions_list", path=path, limit=1))["counts"]
        check(
            "标记条数与引擎计数一致",
            len(marks["marks"]) == wire_counts["insert"] + wire_counts["delete"],
            f'{len(marks["marks"])} vs {wire_counts}',
        )
        check(
            "标记 kind 分布一致",
            sum(1 for mark in marks["marks"] if mark["kind"] == "insert") == wire_counts["insert"],
            json.dumps(wire_counts),
        )
        try:
            server.rpc("resources/read", {"uri": f"{DOCX_RESOURCE}?path=/etc/hosts&meta=1"})
            check("非 docx 路径被拒", False, "竟然读到了 /etc/hosts")
        except AssertionError as error:
            check("非 docx 路径被拒", "只允许读" in str(error), str(error)[:160])
    finally:
        server.close()
    print("\n全部通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
