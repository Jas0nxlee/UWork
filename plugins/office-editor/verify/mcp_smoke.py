#!/usr/bin/env python3
"""office-editor 冒烟测试：造一份带修订的 docx，走 stdio JSON-RPC 驱动服务器。

覆盖：initialize / tools/list / tools/call（列出 → 接受 → 复查 → 拒绝）/ resources/list / resources/read。
只依赖标准库；样本 docx 写在临时目录，跑完即删。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import zipfile
import atexit
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sample_fixture as fixture  # noqa: E402
PLUGIN_ROOT = os.path.dirname(HERE)
SERVER = os.path.join(PLUGIN_ROOT, "server", "server.py")

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


def main() -> int:
    directory = tempfile.mkdtemp(prefix="office-editor-smoke-")
    atexit.register(shutil.rmtree, directory, True)
    path = build_sample(directory)
    baseline_styles = unrelated_part(path)
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
            "tools/list 暴露四个工具",
            names == {"docx_revisions_list", "docx_revisions_resolve", "docx_open_editor", "docx_export_pdf"},
            str(names),
        )

        print("修订读取")
        listed = payload(server.rpc("tools/call", {"name": "docx_revisions_list", "arguments": {"path": path}}))
        check("样本有 1 插入 + 1 删除", listed["counts"] == {"insert": 1, "delete": 1, "comments": 0}, str(listed["counts"]))
        check("修订带作者与文本", listed["revisions"][0]["author"] == "审查员", str(listed["revisions"][0]))

        print("接受单条插入")
        accepted = payload(
            server.rpc(
                "tools/call",
                {"name": "docx_revisions_resolve", "arguments": {"path": path, "action": "accept", "ids": ["101"]}},
            )
        )
        check("处理 1 条插入", accepted["processed"]["insert"] == 1, str(accepted))
        check("写了备份", bool(accepted["backup"]) and os.path.exists(accepted["backup"]), str(accepted.get("backup")))
        xml = document_xml(path)
        check("插入文字仍保留", "插入的新句子。" in xml and "w:ins" not in xml, xml[:200])
        check("删除文字尚未处理", "被删掉的旧句子。" in xml, xml[:200])
        check("无关部件逐字节保留", unrelated_part(path) == baseline_styles)

        print("拒绝剩余删除")
        rejected = payload(
            server.rpc(
                "tools/call",
                {"name": "docx_revisions_resolve", "arguments": {"path": path, "action": "reject"}},
            )
        )
        check("处理 1 条删除", rejected["processed"]["delete"] == 1, str(rejected))
        xml = document_xml(path)
        check("删除文字已恢复为正文", "<w:t>被删掉的旧句子。</w:t>" in xml and "w:delText" not in xml, xml[:300])
        remaining = payload(server.rpc("tools/call", {"name": "docx_revisions_list", "arguments": {"path": path}}))
        check("修订清空", remaining["counts"] == {"insert": 0, "delete": 0, "comments": 0}, str(remaining["counts"]))

        print("未实现工具必须明确失败")
        exported = server.rpc("tools/call", {"name": "docx_export_pdf", "arguments": {"path": path}})
        check("export_pdf 返回 isError", exported.get("isError") is True, str(exported))

        print("页面资源")
        resources = server.rpc("resources/list")["resources"]
        check("暴露 editor 页面", resources[0]["uri"] == "ui://office-editor/editor.html", str(resources))
        check("mime 带 mcp-app profile", resources[0]["mimeType"] == "text/html;profile=mcp-app", resources[0]["mimeType"])
        page = server.rpc("resources/read", {"uri": "ui://office-editor/editor.html"})["contents"][0]
        html = page["text"]
        check("页面含标题", "Word 修订审阅" in html, html[:120])
        check("页面内联了 App 桥", "const App =" in html or "const App=" in html, html[:200])
        check("页面体积在宿主上限内", len(html.encode("utf-8")) < 16 * 1024 * 1024, str(len(html)))
        print(f"  页面大小 {len(html.encode('utf-8')) / 1024:.0f} KiB")
    finally:
        server.close()
    print("\n全部通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
