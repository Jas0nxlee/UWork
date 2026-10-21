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
import io
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import BinaryIO
from xml.etree import ElementTree as ET

from docx_package import serialize_document, validate_archive

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


def _load(path: str | BinaryIO) -> tuple[zipfile.ZipFile, ET.Element, str]:
    archive = zipfile.ZipFile(path)
    try:
        root, xml_text = validate_archive(archive)
        _register_namespaces(xml_text)
        return archive, root, xml_text
    except Exception:
        archive.close()
        raise


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
# 缓存键必须含文件身份；外部编辑器可保留 size/mtime 原子替换，旧键会复用另一份文档的修订。
_parse_cache: dict[tuple, tuple[list[dict], list[dict]]] = {}
_PARSE_CACHE_LIMIT = 4


def _invalidate_cache(path: str) -> None:
    """写回后清缓存：简单可靠，解析成本远低于误用陈旧数据的风险。"""
    _parse_cache.clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(path: str, *, source: BinaryIO | None = None, stat_result: os.stat_result | None = None) -> tuple[list[dict], list[dict]]:
    """返回 (revisions, comments)，按文件大小+mtime 缓存。"""
    absolute = os.path.abspath(path)
    if source is not None and stat_result is None:
        raise ValueError("描述符解析必须提供同一 fd 的文件身份")
    stat = stat_result if stat_result is not None else os.stat(path)
    key = (absolute, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    hit = _parse_cache.get(key)
    if hit is not None:
        return hit
    archive, root, _ = _load(source if source is not None else path)
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


def revision_counts(path: str, *, source: BinaryIO | None = None, stat_result: os.stat_result | None = None) -> dict:
    revisions, comments = _parse(path, source=source, stat_result=stat_result)
    return {
        "insert": sum(1 for item in revisions if item["kind"] == "insert"),
        "delete": sum(1 for item in revisions if item["kind"] == "delete"),
        "comments": len(comments),
    }


def revision_marks(path: str, *, root: ET.Element | None = None, etag: str | None = None) -> dict:
    """紧凑标记（id/kind/文本前缀，文档序），供页面把 docx-preview 的 ``<ins>/<del>`` 与引擎条目对齐。

    只带对齐必需的最小字段：整页渲染时 DOM 里的 ins/del 节点顺序与引擎的文档序遍历一致，
    数量一致就按序贴 id；不一致再退化为按文本前缀匹配。6000 条量级约数百 KB，走资源读（免审批）。
    """
    revisions = _collect_revisions(root) if root is not None else _parse(path)[0]
    return {
        "path": path,
        "etag": etag if etag is not None else document_etag(path),
        "marks": [
            {"id": item["id"], "kind": item["kind"], "text": item["text"]} for item in revisions
        ],
    }


PARAGRAPH_TEXT_CHARS_LIST = 200


def list_paragraphs(path: str, *, root: ET.Element | None = None, etag: str | None = None) -> dict:
    """段落清单（段号 + 文本前缀），供编辑页把渲染出的 ``<p>`` 对回引擎段号后原地编辑。"""
    if root is None:
        _archive, root, _xml = _load(path)
        _archive.close()
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
    return {
        "path": path,
        "etag": etag if etag is not None else document_etag(path),
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


def _make_change(properties: ET.Element | None, tag: str, text: str, change_id: int, author: str, date: str, deleted: bool) -> ET.Element:
    element = ET.Element(
        f"{W}{tag}", {f"{W}id": str(change_id), f"{W}author": author, f"{W}date": date}
    )
    element.append(_make_run(text, properties, deleted=deleted))
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

    v1 仅支持纯文本段落；超链接、域、已有修订与锚点必须由成熟编辑器处理，不能无损重建时拒绝。
    未改动的首尾文本沿用原段落首个 run 的属性。
    """
    absolute = os.path.abspath(path)
    _archive, root, _xml = _load(path)
    _archive.close()  # Windows 上保持 ZIP 句柄会阻止后面的原子替换。
    element = _find_paragraph(root, int(paragraph))
    if element is None:
        raise ValueError(f"找不到第 {paragraph} 段")
    old_text = _paragraph_text(element)
    if old_text == text:
        return {"path": path, "paragraph": paragraph, "changed": False}

    # 旧实现拼接所有后代文本后只移除直属 run，会重复超链接并把已有删除恢复成正文。
    # 受限段落编辑只接受普通文本 run；无法证明保真的结构在备份与修改前明确拒绝。
    for child in element:
        if child.tag == f"{W}pPr":
            continue
        if child.tag != f"{W}r" or any(node.tag not in (f"{W}rPr", f"{W}t") for node in child):
            raise ValueError("段落包含修订、超链接、域、图像或锚点，请使用完整编辑器")

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
    if kept_prefix and tracked:
        new_children.append(_make_run(kept_prefix, properties, deleted=False))
    if tracked:
        change_id = _next_change_id(root)
        date = _now_iso()
        if removed:
            new_children.append(
                _make_change(properties, "del", removed, change_id, author, date, deleted=True)
            )
        if added:
            new_children.append(
                _make_change(properties, "ins", added, change_id + 1, author, date, deleted=False)
            )
    else:
        merged = kept_prefix + added + kept_suffix
        if merged:
            new_children.append(_make_run(merged, properties, deleted=False))
    if kept_suffix and tracked:
        new_children.append(_make_run(kept_suffix, properties, deleted=False))
    for offset, child in enumerate(new_children):
        element.insert(insert_at + offset, child)

    xml_bytes = _serialize(root, _xml)
    backup = _create_backup(path)
    _rewrite_document_part(path, xml_bytes)
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
    _archive.close()
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
            # 删除显式格式会重新继承样式；关闭格式必须写明 false/none 才能覆盖继承值。
            element_node = ET.Element(f"{W}{tag}")
            element_node.set(f"{W}val", ("single" if value else "none") if tag == "u" else ("1" if value else "0"))
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

    xml_bytes = _serialize(root, _xml)
    backup = _create_backup(path)
    _rewrite_document_part(path, xml_bytes)
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


def _create_backup(path: str) -> str:
    directory, name = os.path.split(path)
    stem, extension = os.path.splitext(name)
    index = 1
    while True:
        suffix = "" if index == 1 else f"-{index}"
        candidate = os.path.join(directory, f"{stem}_backup{suffix}{extension}")
        try:
            # exists() 会漏掉失效链接，先检查再 copy2 也有竞态；独占创建保证不跟随或覆盖已有目标。
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            index += 1
            continue
        with os.fdopen(fd, "wb") as target, open(path, "rb") as source:
            shutil.copyfileobj(source, target)
        return candidate


def _serialize(root: ET.Element, original_xml: str) -> bytes:
    return serialize_document(root, original_xml)


def _rewrite_document_part(path: str, xml_bytes: bytes) -> None:
    """把新的 document.xml 写回 zip：其余部件逐字节保留，临时文件 + 原子替换。"""
    directory = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory)
    os.close(fd)
    try:
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(temporary, "w") as target:
            for info in source.infolist():
                target.writestr(info, xml_bytes if info.filename == DOCUMENT_PART else source.read(info))
        shutil.copymode(path, temporary)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def resolve_revisions(path: str, action: str, ids: list[str] | None = None) -> dict:
    """接受或拒绝修订。``ids`` 为空表示全部；只处理当时的快照，返回处理条数。"""
    if action not in ("accept", "reject"):
        raise ValueError(f'action 必须是 "accept" 或 "reject"，收到: {action!r}')
    wanted = {str(item) for item in ids} if ids else None

    archive, root, original_xml = _load(path)
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

    _parse_cache.clear()  # 写回后全清：简单可靠，解析成本远低于误用陈旧数据的风险
    xml_bytes = _serialize(root, original_xml)
    backup = _create_backup(path)
    _rewrite_document_part(path, xml_bytes)
    remaining = list_revisions(path)
    return {
        "path": path,
        "action": action,
        "processed": processed,
        "backup": backup,
        "written": True,
        "remaining": remaining["counts"],
    }

# MCP stdio 帧上限 10 MiB，base64 预算 8 MiB 给路径、版本与协议封装保留余量。
MAX_WRITE_BACK_BASE64_BYTES = 8 * 1024 * 1024


def document_etag(path: str, *, stat_result: os.stat_result | None = None) -> str:
    stat = stat_result if stat_result is not None else os.stat(path)
    return f"{stat.st_dev}-{stat.st_ino}-{stat.st_size}-{stat.st_mtime_ns}-{stat.st_ctime_ns}"


def write_back(path: str, data: bytes, expected_etag: str) -> dict:
    """把编辑器产出的整份 docx 写回原路径：校验 zip 与 document.xml、落备份、原子替换。

    校验的意义是"宁可不写，也不要把坏文件盖到用户文档上"。
    """
    if 4 * ((len(data) + 2) // 3) > MAX_WRITE_BACK_BASE64_BYTES:
        raise ValueError("整份写回超过 6 MiB 文档上限，暂不支持分块保存")
    if len(data) < 4 or data[:2] != b"PK":
        raise ValueError("不是有效的 docx（缺少 zip 头）")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            validate_archive(archive, check_crc=True)
    except zipfile.BadZipFile as error:
        raise ValueError(f"不是有效的 zip/docx: {error}") from error
    # 旧页面快照可能晚于卡片接受/拒绝修订；不比较版本会把已完成审阅静默写回旧状态。
    if not expected_etag or document_etag(path) != expected_etag:
        raise ValueError("文件已变化或缺少加载版本，请重载文档后再保存")
    backup = _create_backup(path)
    directory = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        shutil.copymode(path, temporary)
        if document_etag(path) != expected_etag:
            raise ValueError("保存期间文件已变化，请重载文档后再保存")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    _invalidate_cache(path)
    return {"path": path, "bytes": len(data), "backup": backup, "counts": revision_counts(path), "etag": document_etag(path)}
