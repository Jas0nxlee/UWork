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
