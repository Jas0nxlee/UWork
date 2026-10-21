"""DOCX 合并回归：保真、完整包、乐观并发与页面资源最小授权。"""

from __future__ import annotations

import base64
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
sys.path.insert(0, str(HERE))

import docx_revisions as engine
import server
import sample_fixture as fixture


class DocumentSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="office-safety-")
        self.root = Path(self.temp.name)
        server._last_target = None
        if hasattr(server, "_authorized_targets"):
            server._authorized_targets.clear()

    def tearDown(self):
        self.temp.cleanup()

    def sample(self, name="sample.docx", paragraph=None, attributes=""):
        path = Path(fixture.build_sample(str(self.root), name))
        if paragraph is not None:
            xml = (
                f'<w:document xmlns:w="{engine.W_NS}" {attributes}>'
                f"<w:body><w:p>{paragraph}</w:p></w:body></w:document>"
            )
            self.replace_part(path, "word/document.xml", xml.encode())
        return path

    def replace_part(self, path, name, value):
        with zipfile.ZipFile(path) as source:
            parts = {item.filename: source.read(item) for item in source.infolist()}
        parts[name] = value
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as target:
            for member, content in parts.items():
                target.writestr(member, content)

    def paragraph_text(self, path):
        with zipfile.ZipFile(path) as archive:
            root = ET.fromstring(archive.read(engine.DOCUMENT_PART))
        return engine._paragraph_text(root.find(f".//{engine.W}p"))

    def save(self, path, data, etag=None):
        return server.call_tool("docx_write_back", {
            "path": str(path), "data": base64.b64encode(data).decode(),
            "expectedEtag": etag or server.docx_resource_meta(str(path))["etag"],
        })

    def assert_rejected_without_write(self, path, operation):
        before = path.read_bytes()
        backups = set(self.root.glob("*backup*"))
        with self.assertRaises(ValueError):
            operation()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(set(self.root.glob("*backup*")), backups)

    def test_untracked_edit_does_not_duplicate_shared_prefix(self):
        path = self.sample(paragraph="<w:r><w:t>ABC</w:t></w:r>")
        engine.edit_paragraph(str(path), paragraph=1, text="ABD", tracked=False)
        self.assertEqual(self.paragraph_text(path), "ABD")

    def test_complex_paragraphs_reject_without_losing_content(self):
        contents = [
            '<w:hyperlink><w:r><w:t>LINK</w:t></w:r></w:hyperlink>',
            '<w:del w:id="7"><w:r><w:delText>OLD</w:delText></w:r></w:del>',
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
            '<w:r><w:drawing/></w:r>',
            '<w:bookmarkStart w:id="1" w:name="mark"/>',
        ]
        for index, content in enumerate(contents):
            with self.subTest(content=content):
                path = self.sample(f"complex-{index}.docx", "<w:r><w:t>A</w:t></w:r>" + content)
                self.assert_rejected_without_write(path, lambda: engine.edit_paragraph(
                    str(path), paragraph=1, text="changed", tracked=True,
                ))

    def test_mce_namespace_references_survive_revision_write(self):
        path = self.sample(paragraph='<w:ins w:id="1"><w:r><w:t>A</w:t></w:r></w:ins>', attributes=(
            'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
            'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"'
        ))
        engine.resolve_revisions(str(path), "accept")
        xml = fixture.document_xml(str(path))
        self.assertIn('xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"', xml)
        self.assertIn('mc:Ignorable="w14"', xml)
        ET.fromstring(xml)

    def test_explicit_false_format_overrides_inherited_style(self):
        path = self.sample(paragraph='<w:r><w:rPr><w:rStyle w:val="BoldStyle"/></w:rPr><w:t>A</w:t></w:r>')
        engine.set_paragraph_format(str(path), paragraph=1, bold=False, italic=False, underline=False)
        xml = ET.fromstring(fixture.document_xml(str(path)))
        properties = xml.find(f".//{engine.W}rPr")
        for tag in ("b", "i"):
            self.assertEqual(properties.find(f"{engine.W}{tag}").get(f"{engine.W}val"), "0")
        self.assertEqual(properties.find(f"{engine.W}u").get(f"{engine.W}val"), "none")

    def test_invalid_opc_does_not_replace_original(self):
        path = self.sample()
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("word/document.xml", "<not-a-word-document/>")
        self.assert_rejected_without_write(path, lambda: self.save(path, stream.getvalue()))

    def test_wrong_main_document_relationship_is_rejected(self):
        original = self.sample()
        incoming = self.sample("incoming.docx")
        self.replace_part(incoming, "_rels/.rels", fixture.RELS.replace("word/document.xml", "other.xml").encode())
        self.assert_rejected_without_write(original, lambda: self.save(original, incoming.read_bytes()))

    def test_valid_opc_with_wrong_document_root_is_rejected(self):
        original = self.sample()
        incoming = self.sample("incoming.docx")
        self.replace_part(incoming, "word/document.xml", b"<not-a-word-document/>")
        self.assert_rejected_without_write(original, lambda: self.save(original, incoming.read_bytes()))

    def test_zip_expansion_is_bounded_before_xml_read(self):
        original = self.sample()
        incoming = self.sample("incoming.docx")
        self.replace_part(incoming, "word/large.xml", b"x" * 4096)
        # 小阈值覆盖同一生产检查，避免测试真正在内存里构造压缩炸弹。
        import docx_package
        with patch.object(docx_package, "MAX_PART_BYTES", 2048):
            self.assert_rejected_without_write(original, lambda: self.save(original, incoming.read_bytes()))

    def test_missing_version_is_rejected_before_save(self):
        path = self.sample()
        self.assert_rejected_without_write(path, lambda: server.call_tool("docx_write_back", {
            "path": str(path), "data": base64.b64encode(path.read_bytes()).decode(),
        }))

    def test_stale_version_cannot_undo_revision_resolution(self):
        path = self.sample()
        old_bytes = path.read_bytes()
        old_etag = server.docx_resource_meta(str(path))["etag"]
        engine.resolve_revisions(str(path), "accept")
        self.assert_rejected_without_write(path, lambda: self.save(path, old_bytes, old_etag))

    def test_resource_read_requires_successful_tool_target(self):
        path = self.sample()
        uri = "office://docx?path=" + str(path)
        with self.assertRaises(ValueError):
            server.read_docx_resource(uri)
        server.call_tool("docx_open_editor", {"path": str(path)})
        content = server.read_docx_resource(uri)["contents"][0]
        self.assertEqual(base64.b64decode(content["blob"]), path.read_bytes())

    def test_approved_target_does_not_authorize_other_docx_or_symlink(self):
        approved = self.sample()
        other = self.sample("other.docx")
        server.call_tool("docx_open_editor", {"path": str(approved)})
        for path in (other, self.root / "link.docx"):
            if path.name == "link.docx":
                path.symlink_to(other)
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    server.read_docx_resource("office://docx?path=" + str(path))

    def test_external_replacement_requires_new_tool_authorization(self):
        approved = self.sample()
        server.call_tool("docx_open_editor", {"path": str(approved)})
        replacement = self.sample("replacement.docx")
        os.replace(replacement, approved)
        with self.assertRaises(ValueError):
            server.read_docx_resource("office://docx?path=" + str(approved))
        server.call_tool("docx_open_editor", {"path": str(approved)})
        self.assertTrue(server.read_docx_resource("office://docx?path=" + str(approved))["contents"])

    def test_valid_save_refreshes_resource_authorization_and_version(self):
        path = self.sample()
        server.call_tool("docx_open_editor", {"path": str(path)})
        result = self.save(path, path.read_bytes())["structuredContent"]
        self.assertEqual(result["etag"], server.docx_resource_meta(str(path))["etag"])
        self.assertTrue(server.read_docx_resource("office://docx?path=" + str(path))["contents"])

    def test_eval_relaxation_is_on_the_html_resource_metadata(self):
        resource = server.handle_request({"method": "resources/read", "params": {"uri": server.PAGE_URI}})["contents"][0]
        self.assertTrue(resource.get("_meta", {}).get("zcode/csp", {}).get("unsafeEval"))
        self.assertNotIn("unsafeEval", server._open_editor_ui_marshal().get("csp", {}))

    def test_duplicate_and_traversal_zip_members_are_rejected(self):
        original = self.sample()
        for index, name in enumerate(("../outside.xml", "word/document.xml")):
            incoming = self.sample(f"incoming-{index}.docx")
            with zipfile.ZipFile(incoming, "a") as archive:
                archive.writestr(name, "<extra/>")
            self.assert_rejected_without_write(original, lambda: self.save(original, incoming.read_bytes()))

    def test_corrupt_non_document_part_is_rejected_before_save(self):
        original = self.sample()
        incoming = self.sample("incoming.docx")
        marker = b"uniquely-stored-media-bytes"
        with zipfile.ZipFile(incoming, "a") as archive:
            archive.writestr("word/media/image.bin", marker, compress_type=zipfile.ZIP_STORED)
        data = incoming.read_bytes().replace(marker, marker[:-1] + b"!", 1)
        self.assert_rejected_without_write(original, lambda: self.save(original, data))

    def test_malformed_comments_cannot_fail_after_replacing_original(self):
        original = self.sample()
        incoming = self.sample("incoming.docx")
        self.replace_part(incoming, "word/comments.xml", b"<broken")
        self.assert_rejected_without_write(original, lambda: self.save(original, incoming.read_bytes()))

    def test_namespace_rebinding_is_rejected_before_backup(self):
        path = self.sample(paragraph=(
            '<w:ins w:id="1"><w:r xmlns:ext="urn:second"><w:t>A</w:t></w:r></w:ins>'
        ), attributes='xmlns:ext="urn:first"')
        self.assert_rejected_without_write(path, lambda: engine.resolve_revisions(str(path), "accept"))

    def test_replaced_file_with_preserved_size_and_mtime_invalidates_parse_cache(self):
        path = self.sample(paragraph='<w:ins w:id="1"><w:r><w:t>A</w:t></w:r></w:ins>')
        replacement = self.sample("replacement.docx", '<w:del w:id="1"><w:r><w:t>A</w:t></w:r></w:del>')
        # 使用相同长度的 STORED 部件，模拟编辑器以 copy2 时间戳原子替换同尺寸文件。
        for item in (path, replacement):
            with zipfile.ZipFile(item) as source:
                parts = {info.filename: source.read(info) for info in source.infolist()}
            with zipfile.ZipFile(item, "w", zipfile.ZIP_STORED) as target:
                for name, data in parts.items():
                    target.writestr(name, data)
        self.assertEqual(path.stat().st_size, replacement.stat().st_size)
        stat = path.stat()
        os.utime(replacement, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(engine.revision_counts(str(path))["insert"], 1)
        os.replace(replacement, path)
        self.assertEqual(engine.revision_counts(str(path))["delete"], 1)

    def test_target_swapped_to_symlink_between_authorization_and_open_is_rejected(self):
        for index, suffix in enumerate(("", "&meta=1", "/marks", "/paragraphs")):
            approved = self.sample(f"approved-{index}.docx")
            other = self.sample(f"private-{index}.docx", '<w:r><w:t>PRIVATE</w:t></w:r>')
            server.call_tool("docx_open_editor", {"path": str(approved)})
            original = server._readable_docx

            def swap(raw_path):
                resolved = original(raw_path)
                approved.unlink()
                approved.symlink_to(other)
                return resolved

            endpoint = suffix if suffix.startswith("/") else ""
            query = suffix if suffix.startswith("&") else ""
            uri = f"office://docx{endpoint}?path={approved}{query}"
            with self.subTest(uri=uri), patch.object(server, "_readable_docx", side_effect=swap):
                with self.assertRaises(ValueError):
                    server.read_docx_resource(uri)

    def test_resource_chunk_rejects_a_version_different_from_first_meta(self):
        approved = self.sample()
        server.call_tool("docx_open_editor", {"path": str(approved)})
        with self.assertRaises(ValueError):
            server.read_docx_resource(f"office://docx?path={approved}&etag=old-version")

    def test_resources_reject_path_replacement_after_descriptor_was_opened(self):
        for index, endpoint in enumerate(("", "/marks", "/paragraphs")):
            approved = self.sample(f"approved-{index}.docx")
            replacement = self.sample(f"replacement-{index}.docx")
            server.call_tool("docx_open_editor", {"path": str(approved)})
            original_fstat = server.os.fstat
            changed = False

            def replace_after_fstat(fd):
                nonlocal changed
                stat = original_fstat(fd)
                if not changed:
                    changed = True
                    os.replace(replacement, approved)
                return stat

            with self.subTest(endpoint=endpoint), patch.object(server.os, "fstat", side_effect=replace_after_fstat):
                with self.assertRaises(ValueError):
                    server.read_docx_resource(f"office://docx{endpoint}?path={approved}")

    def test_resources_reject_in_place_changes_during_descriptor_read(self):
        approved = self.sample()
        server.call_tool("docx_open_editor", {"path": str(approved)})
        original_fstat = server.os.fstat
        changed = False

        def edit_after_fstat(fd):
            nonlocal changed
            stat = original_fstat(fd)
            if not changed:
                changed = True
                with approved.open("r+b") as writer:
                    writer.seek(-1, os.SEEK_END)
                    writer.write(b"!")
            return stat

        with patch.object(server.os, "fstat", side_effect=edit_after_fstat):
            with self.assertRaises(ValueError):
                server.read_docx_resource(f"office://docx?path={approved}")

    def test_failed_open_does_not_authorize_a_target_swapped_after_parsing(self):
        approved = self.sample()
        private = self.root / "private.txt"
        private.write_bytes(b"PRIVATE FILE IS NOT A DOCX")
        original_realpath = server.os.path.realpath
        changed = False

        def swap_before_realpath(raw_path, *args, **kwargs):
            nonlocal changed
            if not changed:
                changed = True
                approved.unlink()
                approved.symlink_to(private)
            return original_realpath(raw_path, *args, **kwargs)

        with patch.object(server.os.path, "realpath", side_effect=swap_before_realpath):
            try:
                server.call_tool("docx_open_editor", {"path": str(approved)})
            except (ValueError, zipfile.BadZipFile):
                pass
        with self.assertRaises(ValueError):
            server.read_docx_resource(f"office://docx?path={private}")


if __name__ == "__main__":
    unittest.main()
