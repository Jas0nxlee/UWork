"""样本 docx 夹具：造一份带 1 条插入 + 1 条删除的 .docx（纯标准库），供各验证脚本共用。"""

from __future__ import annotations

import os
import zipfile

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="0"/></w:pPr>
      <w:r><w:t>一、概述</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>第一段：</w:t></w:r>
      <w:ins w:id="101" w:author="审查员" w:date="2026-10-12T09:00:00Z">
        <w:r><w:t>插入的新句子。</w:t></w:r>
      </w:ins>
      <w:del w:id="102" w:author="审查员" w:date="2026-10-12T09:01:00Z">
        <w:r><w:delText>被删掉的旧句子。</w:delText></w:r>
      </w:del>
      <w:r><w:t>尾段。</w:t></w:r>
    </w:p>
  </w:body>
</w:document>"""


def build_sample(directory: str, name: str = "sample.docx") -> str:
    """在目录里生成样本；附带一个无关部件（word/styles.xml）用于验证“逐字节保留”。"""
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", RELS)
        archive.writestr("word/document.xml", DOCUMENT)
        archive.writestr("word/styles.xml", "<styles/>")
    return path


def document_xml(path: str) -> str:
    with zipfile.ZipFile(path) as archive:
        return archive.read("word/document.xml").decode("utf-8")


def unrelated_part(path: str) -> bytes:
    with zipfile.ZipFile(path) as archive:
        return archive.read("word/styles.xml")

def build_large_sample(
    directory: str,
    *,
    name: str = "large.docx",
    paragraphs: int = 4000,
    inserts: int = 800,
    deletes: int = 800,
    comments: int = 300,
    tables: int = 5,
) -> str:
    """大文档样本：几千段落、上千修订、几百批注、若干表格（用于压测与上限验证）。

    生成是确定性的（同一组参数 → 同一份文件），便于对比不同实现的耗时与返回体大小。
    """
    revision_id = 1000
    body: list[str] = []
    table_every = max(paragraphs // max(tables, 1), 1) if tables else 0
    inserts_left, deletes_left = inserts, deletes
    comment_specs: list[tuple[int, str]] = []

    for index in range(1, paragraphs + 1):
        heading = ""
        if index % 500 == 1:
            heading = (
                f'<w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="0"/></w:pPr>'
            )
        runs = [f"<w:r><w:t>第 {index} 段：这是用于压测的正文内容，"
                f"包含足够的字符以便观察上下文截断行为（{index}）。</w:t></w:r>"]

        # 修订：交替插入/删除，分散到不同段落
        if inserts_left > 0 and index % 3 == 0:
            runs.append(
                f'<w:ins w:id="{revision_id}" w:author="审查员" w:date="2026-10-14T10:00:00Z">'
                f"<w:r><w:t>【插入 {revision_id}】</w:t></w:r></w:ins>"
            )
            revision_id += 1
            inserts_left -= 1
        if deletes_left > 0 and index % 3 == 1:
            runs.append(
                f'<w:del w:id="{revision_id}" w:author="审查员" w:date="2026-10-14T10:00:01Z">'
                f"<w:r><w:delText>【删除 {revision_id}】</w:delText></w:r></w:del>"
            )
            revision_id += 1
            deletes_left -= 1

        # 批注：段落上挂范围标记 + 引用
        if len(comment_specs) < comments and index % 7 == 0:
            comment_id = len(comment_specs)
            comment_specs.append((comment_id, f"这是第 {comment_id} 条批注：请确认该段表述。"))
            runs.insert(0, f'<w:commentRangeStart w:id="{comment_id}"/>')
            runs.append(f'<w:commentRangeEnd w:id="{comment_id}"/>')
            runs.append(
                f'<w:r><w:commentReference w:id="{comment_id}"/></w:r>'
            )

        body.append(f"<w:p>{heading}{''.join(runs)}</w:p>")

        if tables and index % table_every == 0:
            rows = "".join(
                "<w:tr>"
                + "".join(
                    f'<w:tc><w:p><w:r><w:t>表 {index} 行 {row} 列 {cell}</w:t></w:r></w:p></w:tc>'
                    for cell in (1, 2)
                )
                + "</w:tr>"
                for row in (1, 2)
            )
            body.append(f"<w:tbl>{rows}</w:tbl>")

    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(body)}</w:body></w:document>"
    )
    comments_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + "".join(
            f'<w:comment w:id="{cid}" w:author="审查员" w:date="2026-10-14T10:05:00Z">'
            f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:comment>"
            for cid, text in comment_specs
        )
        + "</w:comments>"
    )
    content_types = CONTENT_TYPES.replace(
        "</Types>",
        '<Override PartName="/word/comments.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
        "</Types>",
    )

    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", RELS)
        archive.writestr("word/document.xml", document)
        archive.writestr("word/comments.xml", comments_xml)
        archive.writestr("word/styles.xml", "<styles/>")
    return path
