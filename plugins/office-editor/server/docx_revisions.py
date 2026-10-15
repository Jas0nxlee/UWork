"""DOCX 修订（tracked changes）处理：纯标准库实现，不依赖 python-docx / lxml。

只碰 ``word/document.xml``：其余 zip 部件逐字节保留，写回用「临时文件 + os.replace」，
并在原地修改前先落一份 ``<stem>_backup.docx``（已存在则 ``_backup-2``、``_backup-3`` …）。

支持的修订：``w:ins``（插入）、``w:del``（删除，正文在 ``w:delText``）；``w:comment`` 只读列出。
不支持的（明确不猜）：表格合并、图片锚点搬迁、嵌套在 ``w:del`` 里的 ``w:ins`` 的“先删后插”合并语义——
这类文档请先用 Word 自身处理。

安全边界：本模块把文档内容当**数据**，不做任何指令解释；不执行文档里的任何宏/链接。
"""

from __future__ import annotations

import copy
import os
import re
import shutil
import time
import zipfile
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"
DOCUMENT_PART = "word/document.xml"
# 宿主对工具结果有字节上限（content 32 KiB / structuredContent 64 KiB），
# 实测每条修订约 0.6 KiB：25 条 ≈ 16 KiB，40 条约 23 KiB（留出安全余量）。
DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 40
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
PARAGRAPH_TEXT_CHARS = 120
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


# 解析缓存：大文档（几 MB document.xml、上千条修订）下每次翻页/刷新都重解析是不可接受的。
# 缓存键含 size 与 mtime_ns，写回后自动失效（原子替换会换 inode，run 内部也会清）。
_parse_cache: dict[tuple[str, int, int], tuple[list[dict], list[dict]]] = {}
_PARSE_CACHE_LIMIT = 4


def _invalidate_cache(path: str) -> None:
    """写回后清缓存：简单可靠，解析成本远低于误用陈旧数据的风险。"""
    _parse_cache.pop((os.path.abspath(path), 0, 0), None)
    _parse_cache.clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(path: str) -> tuple[list[dict], list[dict]]:
    """返回 (revisions, comments)，按文件大小+mtime 缓存。"""
    absolute = os.path.abspath(path)
    stat = os.stat(path)
    key = (absolute, stat.st_size, stat.st_mtime_ns)
    hit = _parse_cache.get(key)
    if hit is not None:
        return hit
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
                        "text": _snippet(_text_of(element, "t"), 200),
                    }
                )
    finally:
        archive.close()
    if len(_parse_cache) >= _PARSE_CACHE_LIMIT:
        _parse_cache.clear()
    _parse_cache[key] = (revisions, comments)
    return revisions, comments


def _page(items: list, offset: int, limit: int) -> dict:
    total = len(items)
    start = max(int(offset), 0)
    size = max(min(int(limit), MAX_PAGE_SIZE), 1)
    window = items[start : start + size]
    return {
        "items": window,
        "total": total,
        "offset": start,
        "limit": size,
        "hasMore": start + len(window) < total,
        "nextOffset": start + len(window),
    }


def list_revisions(
    path: str, *, offset: int = 0, limit: int = DEFAULT_PAGE_SIZE, kind: str | None = None
) -> dict:
    """分页列出修订。总数与分布始终给全量，仅条目按页返回——单次返回体必须远小于宿主上限。"""
    revisions, comments = _parse(path)
    filtered = revisions if kind in (None, "") else [item for item in revisions if item["kind"] == kind]
    page = _page(filtered, offset, limit)
    page["counts"] = {
        "insert": sum(1 for item in revisions if item["kind"] == "insert"),
        "delete": sum(1 for item in revisions if item["kind"] == "delete"),
        "comments": len(comments),
    }
    page["kind"] = kind or None
    return page


def list_comments(path: str, *, offset: int = 0, limit: int = DEFAULT_PAGE_SIZE) -> dict:
    """分页列出批注（只读）。"""
    _, comments = _parse(path)
    page = _page(comments, offset, limit)
    page["total"] = len(comments)
    return page


def revision_counts(path: str) -> dict:
    revisions, comments = _parse(path)
    return {
        "insert": sum(1 for item in revisions if item["kind"] == "insert"),
        "delete": sum(1 for item in revisions if item["kind"] == "delete"),
        "comments": len(comments),
    }


def revision_marks(path: str) -> dict:
    """紧凑标记（id/kind/文本前缀，文档序），供页面把 docx-preview 的 ``<ins>/<del>`` 与引擎条目对齐。

    只带对齐必需的最小字段：整页渲染时 DOM 里的 ins/del 节点顺序与引擎的文档序遍历一致，
    数量一致就按序贴 id；不一致再退化为按文本前缀匹配。6000 条量级约数百 KB，走资源读（免审批）。
    """
    revisions, _ = _parse(path)
    stat = os.stat(path)
    return {
        "path": path,
        "etag": f"{stat.st_size}-{stat.st_mtime_ns}",
        "marks": [
            {"id": item["id"], "kind": item["kind"], "text": item["text"]} for item in revisions
        ],
    }


PARAGRAPH_TEXT_CHARS_LIST = 200


def list_paragraphs(path: str) -> dict:
    """段落清单（段号 + 文本前缀），供编辑页把渲染出的 ``<p>`` 对回引擎段号后原地编辑。"""
    _archive, root, _xml = _load(path)
    paragraphs: list[dict] = []
    state = {"paragraph": 0}

    def visit(node: ET.Element) -> None:
        for child in list(node):
            if child.tag == f"{W}tbl":
                for row in child.findall(f"{W}tr"):
                    for cell in row.findall(f"{W}tc"):
                        visit(cell)
                continue
            if child.tag == f"{W}p":
                state["paragraph"] += 1
                paragraphs.append(
                    {
                        "index": state["paragraph"],
                        "text": _snippet(_paragraph_text(child), PARAGRAPH_TEXT_CHARS_LIST),
                    }
                )
                continue
            visit(child)

    visit(root)
    stat = os.stat(path)
    return {
        "path": path,
        "etag": f"{stat.st_size}-{stat.st_mtime_ns}",
        "paragraphs": paragraphs,
    }


def _find_paragraph(root: ET.Element, index: int) -> ET.Element | None:
    """按文档序取第 ``index`` 个 ``w:p``——与 ``_collect_revisions`` 的段落编号同一口径（表格内也计入）。"""
    counter = 0

    def visit(node: ET.Element):
        nonlocal counter
        for child in list(node):
            if child.tag == f"{W}tbl":
                for row in child.findall(f"{W}tr"):
                    for cell in row.findall(f"{W}tc"):
                        hit = visit(cell)
                        if hit is not None:
                            return hit
                continue
            if child.tag == f"{W}p":
                counter += 1
                if counter == index:
                    return child
                continue
            hit = visit(child)
            if hit is not None:
                return hit
        return None

    return visit(root)


def _next_change_id(root: ET.Element) -> int:
    highest = 0
    for tag in (f"{W}ins", f"{W}del"):
        for element in root.iter(tag):
            raw = element.get(f"{W}id")
            if raw and raw.isdigit():
                highest = max(highest, int(raw))
    return highest + 1


def _common_affixes(old: str, new: str) -> tuple[int, int]:
    """公共前缀/后缀长度（后缀不与前缀重叠）——用它把一次编辑缩成最小改动段。"""
    prefix = 0
    limit = min(len(old), len(new))
    while prefix < limit and old[prefix] == new[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and old[len(old) - 1 - suffix] == new[len(new) - 1 - suffix]:
        suffix += 1
    return prefix, suffix


def _first_run_properties(paragraph: ET.Element) -> ET.Element | None:
    for run in paragraph.iter(f"{W}r"):
        properties = run.find(f"{W}rPr")
        if properties is not None:
            return copy.deepcopy(properties)
    return None


def _make_run(text: str, properties: ET.Element | None, deleted: bool) -> ET.Element:
    run = ET.Element(f"{W}r")
    if properties is not None:
        run.append(copy.deepcopy(properties))
    node = ET.SubElement(run, f"{W}delText" if deleted else f"{W}t")
    node.text = text
    node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return run


def _make_change(paragraph: ET.Element, tag: str, text: str, change_id: int, author: str, date: str, deleted: bool) -> ET.Element:
    element = ET.Element(
        f"{W}{tag}", {f"{W}id": str(change_id), f"{W}author": author, f"{W}date": date}
    )
    element.append(_make_run(text, _first_run_properties(paragraph), deleted=deleted))
    return element


def edit_paragraph(
    path: str,
    *,
    paragraph: int,
    text: str,
    tracked: bool = True,
    author: str = "应用内编辑",
) -> dict:
    """把第 ``paragraph`` 个段落的文本改成 ``text``。

    ``tracked=True``（默认）：公共前后缀保留，只有中间改动段落成 ``w:del`` + ``w:ins``——
    文档在 Word 里打开仍是"未接受的修订"，可被本插件的接受/拒绝流程处理。
    ``tracked=False``：直接改写（不留修订）。

    v1 以**整段文本**为单位：段落内的局部格式（局部加粗、超链接、域）在编辑后不保留；
    未改动的首尾文本沿用原段落首个 run 的属性。
    """
    absolute = os.path.abspath(path)
    _archive, root, _xml = _load(path)
    element = _find_paragraph(root, int(paragraph))
    if element is None:
        raise ValueError(f"找不到第 {paragraph} 段")
    old_text = _paragraph_text(element)
    if old_text == text:
        return {"path": path, "paragraph": paragraph, "changed": False}

    properties = _first_run_properties(element)
    prefix_length, suffix_length = _common_affixes(old_text, text)
    removed = old_text[prefix_length : len(old_text) - suffix_length if suffix_length else len(old_text)]
    added = text[prefix_length : len(text) - suffix_length if suffix_length else len(text)]
    kept_prefix = old_text[:prefix_length]
    kept_suffix = old_text[len(old_text) - suffix_length :] if suffix_length else ""

    # 只替换 run 级内容：w:pPr、书签与批注锚点等非 run 子元素原位保留（否则批注会失锚）。
    for child in list(element):
        if child.tag in (f"{W}r", f"{W}ins", f"{W}del"):
            element.remove(child)
    insert_at = list(element).index(element.find(f"{W}pPr")) + 1 if element.find(f"{W}pPr") is not None else 0
    new_children: list[ET.Element] = []
    if kept_prefix:
        new_children.append(_make_run(kept_prefix, properties, deleted=False))
    if tracked:
        change_id = _next_change_id(root)
        date = _now_iso()
        if removed:
            new_children.append(
                _make_change(element, "del", removed, change_id, author, date, deleted=True)
            )
        if added:
            new_children.append(
                _make_change(element, "ins", added, change_id + 1, author, date, deleted=False)
            )
    else:
        merged = kept_prefix + added + kept_suffix
        if merged:
            new_children.append(_make_run(merged, properties, deleted=False))
    if kept_suffix and tracked:
        new_children.append(_make_run(kept_suffix, properties, deleted=False))
    for offset, child in enumerate(new_children):
        element.insert(insert_at + offset, child)

    backup = _unique_backup_path(path)
    shutil.copy2(path, backup)
    _rewrite_document_part(path, _serialize(root))
    _invalidate_cache(absolute)
    return {
        "path": path,
        "paragraph": paragraph,
        "changed": True,
        "tracked": tracked,
        "removed": _snippet(removed, 100),
        "added": _snippet(added, 100),
        "backup": backup,
    }


def set_paragraph_format(
    path: str, *, paragraph: int, bold: bool | None = None, italic: bool | None = None,
    underline: bool | None = None, align: str | None = None,
) -> dict:
    """段落格式：``bold``/``italic``/``underline`` 落到每个 run 的 ``w:rPr``，``align`` 落到 ``w:pPr/w:jc``。

    注意：格式改动目前**直接生效、不留修订**（格式修订 ``w:rPrChange``/``w:pPrChange`` 属二期后续）。
    """
    _archive, root, _xml = _load(path)
    element = _find_paragraph(root, int(paragraph))
    if element is None:
        raise ValueError(f"找不到第 {paragraph} 段")
    if align is not None and align not in ("left", "center", "right", "justify"):
        raise ValueError(f"不支持的 align: {align}")

    flags = {"b": bold, "i": italic, "u": underline}
    for run in element.iter(f"{W}r"):
        properties = run.find(f"{W}rPr")
        for tag, value in flags.items():
            if value is None:
                continue
            if properties is None:
                properties = ET.Element(f"{W}rPr")
                run.insert(0, properties)
            existing = properties.find(f"{W}{tag}")
            if existing is not None:
                properties.remove(existing)
            if value:
                element_node = ET.Element(f"{W}{tag}")
                if tag == "u":
                    element_node.set(f"{W}val", "single")
                properties.insert(len(properties), element_node)
    if align is not None:
        properties = element.find(f"{W}pPr")
        if properties is None:
            properties = ET.Element(f"{W}pPr")
            element.insert(0, properties)
        existing = properties.find(f"{W}jc")
        if existing is not None:
            properties.remove(existing)
        node = ET.SubElement(properties, f"{W}jc")
        node.set(f"{W}val", align)

    backup = _unique_backup_path(path)
    shutil.copy2(path, backup)
    _rewrite_document_part(path, _serialize(root))
    _invalidate_cache(os.path.abspath(path))
    return {
        "path": path,
        "paragraph": paragraph,
        "bold": bold,
        "italic": italic,
        "underline": underline,
        "align": align,
        "backup": backup,
    }


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

    _parse_cache.pop((os.path.abspath(path), 0, 0), None)
    _parse_cache.clear()  # 写回后全清：简单可靠，解析成本远低于误用陈旧数据的风险
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
