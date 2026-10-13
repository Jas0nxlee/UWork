"""DOCX 修订（tracked changes）处理：纯标准库实现，不依赖 python-docx / lxml。

只碰 ``word/document.xml``：其余 zip 部件逐字节保留，写回用「临时文件 + os.replace」，
并在原地修改前先落一份 ``<stem>_backup.docx``（已存在则 ``_backup-2``、``_backup-3`` …）。

支持的修订：``w:ins``（插入）、``w:del``（删除，正文在 ``w:delText``）；``w:comment`` 只读列出。
不支持的（明确不猜）：表格合并、图片锚点搬迁、嵌套在 ``w:del`` 里的 ``w:ins`` 的“先删后插”合并语义——
这类文档请先用 Word 自身处理。

安全边界：本模块把文档内容当**数据**，不做任何指令解释；不执行文档里的任何宏/链接。
"""

from __future__ import annotations

import os
import re
import shutil
import time
import zipfile
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"
DOCUMENT_PART = "word/document.xml"
COMMENTS_PART = "word/comments.xml"


def _register_namespaces(xml_text: str) -> None:
    """把 XML 里出现过的所有前缀登记给 ElementTree，避免回写时被改成 ns0/ns1 而丢样式。"""
    for prefix, uri in re.findall(r'xmlns:([A-Za-z0-9_]+)="([^"]+)"', xml_text):
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:  # 保留前缀（如 xml）不能注册，忽略
            pass


def _text_of(element: ET.Element, text_tag: str) -> str:
    return "".join(node.text or "" for node in element.iter(f"{W}{text_tag}"))


def _load(path: str) -> tuple[zipfile.ZipFile, ET.Element, str]:
    archive = zipfile.ZipFile(path)
    if DOCUMENT_PART not in archive.namelist():
        archive.close()
        raise ValueError(f"不是有效的 docx（缺少 {DOCUMENT_PART}）: {path}")
    xml_text = archive.read(DOCUMENT_PART).decode("utf-8")
    _register_namespaces(xml_text)
    return archive, ET.fromstring(xml_text), xml_text


CONTEXT_BEFORE_CHARS = 60
CONTEXT_AFTER_CHARS = 60
PARAGRAPH_TEXT_CHARS = 200
HEADING_STYLE_PATTERN = re.compile(r"^(?:heading\s*(\d+)|标题\s*(\d+)|(\d+))$", re.IGNORECASE)


def _paragraph_text(paragraph: ET.Element) -> str:
    """段落可见文本：`w:t` 与 `w:delText` 按文档顺序拼接（被删除的文字也要出现在上下文里）。"""
    parts = []
    for node in paragraph.iter():
        if node.tag in (f"{W}t", f"{W}delText"):
            parts.append(node.text or "")
    return "".join(parts)


def _heading_level(paragraph: ET.Element) -> int | None:
    """标题层级：优先 `w:outlineLvl`，其次样式 id（Heading 1 / 标题 1 / 1）。"""
    properties = paragraph.find(f"{W}pPr")
    if properties is not None:
        outline = properties.find(f"{W}outlineLvl")
        if outline is not None:
            value = outline.get(f"{W}val")
            if value is not None and value.isdigit():
                return int(value) + 1
        style = properties.find(f"{W}pStyle")
        if style is not None:
            style_id = (style.get(f"{W}val") or "").strip()
            match = HEADING_STYLE_PATTERN.match(style_id)
            if match:
                for group in match.groups():
                    if group:
                        return int(group)
    return None


def _context_around(paragraph_text: str, change_text: str) -> dict:
    """把变更文本在段落里的前后文切出来；截断方向朝"离变更越近越保留"。"""
    if not change_text:
        return {"before": "", "after": ""}
    index = paragraph_text.find(change_text)
    if index < 0:
        return {"before": "", "after": ""}
    before = paragraph_text[:index]
    after = paragraph_text[index + len(change_text) :]
    if len(before) > CONTEXT_BEFORE_CHARS:
        before = "…" + before[-CONTEXT_BEFORE_CHARS:]
    if len(after) > CONTEXT_AFTER_CHARS:
        after = after[:CONTEXT_AFTER_CHARS] + "…"
    return {"before": before, "after": after}


def _collect_revisions(root: ET.Element) -> list[dict]:
    """按文档顺序遍历，为每条修订附上位置（段落/表格）与上下文（最近标题、前后文）。"""
    records: list[dict] = []
    state = {"paragraph": 0, "heading": None, "table": 0}

    def visit(node: ET.Element, table: dict | None) -> None:
        for child in list(node):
            if child.tag == f"{W}tbl":
                state["table"] += 1
                rows = child.findall(f"{W}tr")
                for row_index, row in enumerate(rows, start=1):
                    for cell_index, cell in enumerate(row.findall(f"{W}tc"), start=1):
                        visit(
                            cell,
                            {
                                "index": state["table"],
                                "row": row_index,
                                "cell": cell_index,
                                "rows": len(rows),
                                "cells": len(row.findall(f"{W}tc")),
                            },
                        )
                continue
            if child.tag == f"{W}p":
                state["paragraph"] += 1
                text = _paragraph_text(child)
                level = _heading_level(child)
                if level is not None:
                    state["heading"] = {"text": _snippet(text, 60), "level": level}
                for element in child.iter():
                    if element.tag not in (f"{W}ins", f"{W}del"):
                        continue
                    is_insert = element.tag == f"{W}ins"
                    change_text = _text_of(element, "t" if is_insert else "delText")
                    records.append(
                        {
                            "id": element.get(f"{W}id", ""),
                            "kind": "insert" if is_insert else "delete",
                            "author": element.get(f"{W}author", ""),
                            "date": element.get(f"{W}date", ""),
                            "text": _snippet(change_text),
                            "characters": len(change_text),
                            "paragraph": state["paragraph"],
                            "table": table,
                            "nearestHeading": state["heading"],
                            "context": _context_around(text, change_text),
                            "paragraphText": _snippet(text, PARAGRAPH_TEXT_CHARS),
                        }
                    )
                continue
            if child.tag == f"{W}sdt":
                visit(child, table)  # 内容控件包一层，继续往下找段落
                continue
            if len(child):
                visit(child, table)

    body = root.find(f"{W}body")
    visit(body if body is not None else root, None)
    return records


def _snippet(text: str, limit: int = 80) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def list_revisions(path: str) -> dict:
    """列出文档里的修订与批注。返回 {revisions: [...], comments: [...], counts: {...}}。"""
    archive, root, _ = _load(path)
    try:
        revisions = _collect_revisions(root)
        comments: list[dict] = []
        if COMMENTS_PART in archive.namelist():
            comments_root = ET.fromstring(archive.read(COMMENTS_PART).decode("utf-8"))
            for element in comments_root.iter(f"{W}comment"):
                comments.append(
                    {
                        "id": element.get(f"{W}id", ""),
                        "author": element.get(f"{W}author", ""),
                        "date": element.get(f"{W}date", ""),
                        "text": _snippet(_text_of(element, "t")),
                    }
                )
        return {
            "revisions": revisions,
            "comments": comments,
            "counts": {
                "insert": sum(1 for item in revisions if item["kind"] == "insert"),
                "delete": sum(1 for item in revisions if item["kind"] == "delete"),
                "comments": len(comments),
            },
        }
    finally:
        archive.close()


def _replace_with_children(parent: ET.Element, element: ET.Element) -> None:
    """把 element 解包成它的子节点（保留尾文本），用于“接受插入 / 拒绝删除”。"""
    index = list(parent).index(element)
    children = list(element)
    if children:
        children[-1].tail = (children[-1].tail or "") + (element.tail or "")
    else:
        previous = parent[index - 1] if index > 0 else None
        if previous is not None:
            previous.tail = (previous.tail or "") + (element.tail or "")
    parent.remove(element)
    for offset, child in enumerate(children):
        parent.insert(index + offset, child)


def _accept(parent: ET.Element, element: ET.Element) -> None:
    if element.tag == f"{W}ins":
        _replace_with_children(parent, element)
    else:
        parent.remove(element)  # 删除被接受：连同内容一起丢掉


def _reject(parent: ET.Element, element: ET.Element) -> None:
    if element.tag == f"{W}ins":
        parent.remove(element)
        return
    for node in element.iter(f"{W}delText"):
        node.tag = f"{W}t"  # 拒绝删除：恢复为正文
    _replace_with_children(parent, element)


def _unique_backup_path(path: str) -> str:
    directory, name = os.path.split(path)
    stem, extension = os.path.splitext(name)
    candidate = os.path.join(directory, f"{stem}_backup{extension}")
    index = 2
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{stem}_backup-{index}{extension}")
        index += 1
    return candidate


def _serialize(root: ET.Element) -> bytes:
    return b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + ET.tostring(
        root, encoding="utf-8", xml_declaration=False
    )


def _rewrite_document_part(path: str, xml_bytes: bytes) -> None:
    """把新的 document.xml 写回 zip：其余部件逐字节保留，临时文件 + 原子替换。"""
    directory = os.path.dirname(os.path.abspath(path))
    temporary = os.path.join(directory, f".{os.path.basename(path)}.{int(time.time() * 1000)}.tmp")
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(temporary, "w") as target:
        for info in source.infolist():
            if info.filename == DOCUMENT_PART:
                target.writestr(info, xml_bytes)
            else:
                target.writestr(info, source.read(info.filename))
    os.replace(temporary, path)


def resolve_revisions(path: str, action: str, ids: list[str] | None = None) -> dict:
    """接受或拒绝修订。``ids`` 为空表示全部；只处理当时的快照，返回处理条数。"""
    if action not in ("accept", "reject"):
        raise ValueError(f'action 必须是 "accept" 或 "reject"，收到: {action!r}')
    wanted = {str(item) for item in ids} if ids else None

    archive, root, _ = _load(path)
    archive.close()

    processed = {"insert": 0, "delete": 0, "skipped": 0}
    # 先收集再改：遍历时改树会让迭代器失效（父节点被解包/移除）。
    targets: list[tuple[ET.Element, ET.Element]] = []
    for parent in root.iter():
        for child in list(parent):
            if child.tag in (f"{W}ins", f"{W}del"):
                targets.append((parent, child))
    for parent, element in targets:
        element_id = element.get(f"{W}id", "")
        if wanted is not None and element_id not in wanted:
            processed["skipped"] += 1
            continue
        if element not in parent:
            processed["skipped"] += 1
            continue
        (_accept if action == "accept" else _reject)(parent, element)
        processed["insert" if element.tag == f"{W}ins" else "delete"] += 1

    if processed["insert"] == 0 and processed["delete"] == 0:
        return {"path": path, "action": action, "processed": processed, "backup": None, "written": False}

    backup = _unique_backup_path(path)
    shutil.copy2(path, backup)
    _rewrite_document_part(path, _serialize(root))
    remaining = list_revisions(path)
    return {
        "path": path,
        "action": action,
        "processed": processed,
        "backup": backup,
        "written": True,
        "remaining": remaining["counts"],
    }
