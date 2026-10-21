"""DOCX 包边界：先限定展开成本，再验证 OPC；回写保留 MCE 前缀语义。"""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET
from xml.sax.saxutils import quoteattr

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
DOCUMENT_PART = "word/document.xml"
MAX_MEMBERS = 10_000
MAX_PART_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAIN_CONTENT_TYPES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "application/vnd.ms-word.document.macroEnabled.main+xml",
}


def validate_archive(archive: zipfile.ZipFile, *, check_crc: bool = False) -> tuple[ET.Element, str]:
    """不得在检查 central-directory 展开大小之前读取任何 ZIP 部件。"""
    members = archive.infolist()
    if len(members) > MAX_MEMBERS:
        raise ValueError("DOCX 部件数量超过安全上限")
    names = set()
    total = 0
    for member in members:
        name = member.filename
        # ZIP 不落地解包，但越界与重复成员仍会导致校验和实际正文选择不一致。
        if (not name or "\\" in name or name.startswith("/")
                or ".." in name.split("/") or name in names):
            raise ValueError(f"DOCX 部件名非法或重复: {name}")
        names.add(name)
        total += member.file_size
        if member.file_size > MAX_PART_BYTES or total > MAX_TOTAL_BYTES:
            raise ValueError("DOCX 展开大小超过安全上限")
        if member.flag_bits & 1:
            raise ValueError("不支持加密 DOCX 部件")
    required = {"[Content_Types].xml", "_rels/.rels", DOCUMENT_PART}
    if not required.issubset(names):
        raise ValueError("不是有效的 DOCX：缺少 OPC 内容类型、根关系或正文")
    try:
        types = ET.fromstring(archive.read("[Content_Types].xml"))
        relationships = ET.fromstring(archive.read("_rels/.rels"))
        xml_bytes = archive.read(DOCUMENT_PART)
        root = ET.fromstring(xml_bytes)
        # 保存后的计数还会读取批注；必须提前校验，不能替换原文件后才发现 XML 解析失败。
        if "word/comments.xml" in names:
            comments = ET.fromstring(archive.read("word/comments.xml"))
            if comments.tag != f"{{{W_NS}}}comments":
                raise ValueError("DOCX 批注根节点无效")
    except (ET.ParseError, zipfile.BadZipFile, UnicodeError) as error:
        raise ValueError(f"DOCX 包 XML 无效: {error}") from error
    if types.tag != f"{{{CONTENT_NS}}}Types":
        raise ValueError("DOCX 内容类型根节点无效")
    main_types = [item.get("ContentType") for item in types.findall(f"{{{CONTENT_NS}}}Override")
                  if item.get("PartName") == "/" + DOCUMENT_PART]
    if len(main_types) != 1 or main_types[0] not in MAIN_CONTENT_TYPES:
        raise ValueError("DOCX 正文内容类型无效")
    if relationships.tag != f"{{{REL_NS}}}Relationships":
        raise ValueError("DOCX 根关系节点无效")
    main_relationships = [item for item in relationships.findall(f"{{{REL_NS}}}Relationship")
                          if item.get("Type") == OFFICE_REL]
    if (len(main_relationships) != 1
            or main_relationships[0].get("TargetMode") == "External"
            or posixpath.normpath(main_relationships[0].get("Target", "").lstrip("/")) != DOCUMENT_PART):
        raise ValueError("DOCX 根关系没有指向包内正文")
    if root.tag != f"{{{W_NS}}}document" or root.find(f"{{{W_NS}}}body") is None:
        raise ValueError("DOCX 正文必须包含 w:document/w:body")
    if check_crc:
        try:
            invalid = archive.testzip()
        except (zipfile.BadZipFile, RuntimeError) as error:
            raise ValueError(f"DOCX ZIP 完整性校验失败: {error}") from error
        if invalid:
            raise ValueError(f"DOCX 部件完整性校验失败: {invalid}")
        for name in names:
            if name.endswith((".xml", ".rels")):
                try:
                    ET.fromstring(archive.read(name))
                except ET.ParseError as error:
                    raise ValueError(f"DOCX 部件 XML 无效: {name}") from error
    return root, xml_bytes.decode("utf-8")


def serialize_document(root: ET.Element, original_xml: str) -> bytes:
    """ElementTree 不记录未用在标签里的 xmlns，必须保留 MCE 属性值所引用的声明。"""
    namespaces = {}
    for _event, (prefix, uri) in ET.iterparse(io.StringIO(original_xml), events=("start-ns",)):
        if prefix in namespaces and namespaces[prefix] != uri:
            # 无法证明重绑定后的 QName 属性值仍等价时拒绝写入，不静默改变其语义。
            raise ValueError(f"暂不支持同一前缀的命名空间重绑定: {prefix}")
        namespaces[prefix] = uri
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass
    body = ET.tostring(root, encoding="unicode", xml_declaration=False)
    end = body.index(">")
    start = body[:end]
    declared = set(re.findall(r"\bxmlns(?::([\w.-]+))?=", start))
    extra = []
    for prefix, uri in namespaces.items():
        if prefix == "xml" or prefix in declared:
            continue
        label = f"xmlns:{prefix}" if prefix else "xmlns"
        extra.append(f" {label}={quoteattr(uri)}")
    body = start + "".join(extra) + body[end:]
    return b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + body.encode("utf-8")
