/**
 * 行为检查用的**一次性用例片段**：这些函数通过字符串拼进页面脚本（它们要跑在浏览器里、
 * 用到引擎实例与我们自己的模块），放这里只是为了守住单文件 400 行上限。
 */
export const CASE_SNIPPETS = `
  /**
   * 写回前校验：好产物通过；坏产物（缺部件 / XML 截断 / 断关系 / 内容塌陷）必须被拦下。
   */
  window.__validateCase = async () => {
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const build = async (options = {}) => {
      const zip = new window.JSZip();
      if (!options.dropContentTypes)
        zip.file(
          "[Content_Types].xml",
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        );
      zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
      const body = options.collapsed
        ? "<w:p><w:r><w:t>只剩一点</w:t></w:r></w:p>"
        : "<w:p><w:r><w:t>" + "这是用于校验的正文内容。".repeat(20) + "</w:t></w:r></w:p>";
      const drawing = options.dangling ? '<w:r><w:drawing><a:blip r:embed="rIdMissing"/></w:drawing></w:r>' : "";
      const document = options.truncated
        ? '<w:document ' + XMLNS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>截断'
        : '<w:document ' + XMLNS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' + body + drawing + "</w:body></w:document>";
      zip.file("word/document.xml", document);
      zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
      return await zip.generateAsync({ type: "arraybuffer" });
    };
    const source = await build();
    const run = async (candidate) => {
      const result = await window.__validateApi(candidate, source);
      return { ok: result.ok, codes: result.issues.map((issue) => issue.code) };
    };
    return {
      good: await run(await build()),
      collapsed: await run(await build({ collapsed: true })),
      dangling: await run(await build({ dangling: true })),
      truncated: await run(await build({ truncated: true })),
      missingPart: await run(await build({ dropContentTypes: true })),
    };
  };

  /**
   * 修订模式用例：基线文档 → "编辑后"文档（改一段、加一段、删一段）→ 落成 w:ins/w:del。
   * 判据：接受全部修订 == 编辑后的样子；拒绝全部修订 == 基线（与 Word 口径一致）。
   */
  window.__trackChangesCase = async () => {
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const paragraph = (text) => '<w:p><w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>';
    const doc = (paragraphs) => '<w:document ' + XMLNS + '><w:body>' + paragraphs.join("") + '</w:body></w:document>';
    // applyTrackedChanges 收的是 **docx（zip）字节**：这里现场打两个最小 zip
    const zipOf = async (documentXml) => {
      const zip = new window.JSZip();
      zip.file(
        "[Content_Types].xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      zip.file("word/document.xml", documentXml);
      return await zip.generateAsync({ type: "arraybuffer" });
    };
    const baseline = doc([paragraph("第一段原样"), paragraph("第二段要改旧内容"), paragraph("第三段要删")]);
    const edited = doc([paragraph("第一段原样"), paragraph("第二段要改新内容"), paragraph("新增的一段")]);
    const result = await window.__trackedApi.applyTrackedChanges(await zipOf(baseline), await zipOf(edited), {
      author: "UWork",
      date: "2026-10-16T00:00:00.000Z",
    });
    const zip = await window.JSZip.loadAsync(result.bytes);
    const xml = await zip.file("word/document.xml").async("string");
    return {
      stats: result.stats,
      hasIns: new RegExp("<w:ins[ >]").test(xml),
      hasDel: new RegExp("<w:del[ >]").test(xml),
      hasDelText: new RegExp("<w:delText").test(xml),
      accepted: window.__trackedApi.acceptedText(xml),
      rejected: window.__trackedApi.rejectedText(xml, baseline),
      editedText: ["第一段原样", "第二段要改新内容", "新增的一段"].join("\\n"),
      baselineText: ["第一段原样", "第二段要改旧内容", "第三段要删"].join("\\n"),
    };
  };

  /**
   * 页眉页脚用例：造"源无页脚"与"源有页脚"两份文档，各走一次 preserveHeaderFooter，
   * 与"插件导出（总带自己的 PAGE 页脚）"对比。
   */
  window.__headerFooterCases = async () => {
    const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const CONTENT_TYPES_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
    const FOOTER_OVERRIDE = '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>';
    const HEADER_OVERRIDE = '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>';

    const buildSource = async (withFooter) => {
      const zip = new window.JSZip();
      zip.file("[Content_Types].xml", CONTENT_TYPES_HEAD + (withFooter ? FOOTER_OVERRIDE : "") + "</Types>");
      zip.file("word/document.xml", '<w:document ' + XMLNS + '><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>');
      if (withFooter)
        zip.file("word/footer1.xml", '<w:ftr ' + XMLNS + '><w:p><w:r><w:t>公司页脚 FOOTER-MARK</w:t></w:r></w:p></w:ftr>');
      return new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }));
    };
    // 模拟插件导出：总带自己的页眉页脚
    const exportZip = new window.JSZip();
    exportZip.file("[Content_Types].xml", CONTENT_TYPES_HEAD + FOOTER_OVERRIDE + HEADER_OVERRIDE + "</Types>");
    exportZip.file(
      "word/document.xml",
      '<w:document ' + XMLNS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rId6"/><w:footerReference w:type="default" r:id="rId7"/></w:sectPr></w:body></w:document>',
    );
    exportZip.file("word/footer1.xml", '<w:ftr ' + XMLNS + '><w:p><w:r><w:t>PAGE</w:t></w:r></w:p></w:ftr>');
    exportZip.file("word/header1.xml", '<w:hdr ' + XMLNS + '><w:p/></w:hdr>');
    const exported = encode(new Uint8Array(await exportZip.generateAsync({ type: "arraybuffer" })));

    return {
      plain: await window.__preserveHeaderFooter(encode(await buildSource(false)), exported),
      withFooter: await window.__preserveHeaderFooter(encode(await buildSource(true)), exported),
    };
  };

  /** 页眉页脚保留：给源文档与导出文档的字节，返回处理后的 zip 结构摘要。 */
  window.__preserveHeaderFooter = async (sourceB64, exportedB64) => {
    const toBuffer = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const result = await preserveHeaderFooter(toBuffer(sourceB64), toBuffer(exportedB64));
    const zip = await window.JSZip.loadAsync(result.bytes);
    const document = await zip.file("word/document.xml")?.async("string");
    const footer = await zip.file("word/footer1.xml")?.async("string");
    return {
      note: result.note,
      parts: Object.keys(zip.files).filter((n) => new RegExp("word/(header|footer)[0-9]*[.]xml$").test(n)),
      headerRefs: (document?.match(new RegExp("<w:headerReference", "g")) ?? []).length,
      footerRefs: (document?.match(new RegExp("<w:footerReference", "g")) ?? []).length,
      footerText: footer ?? "",
    };
  };

  /** 写能力探测：老远端抛 Method not found 判为不支持；版本不匹配（新服务端）判为支持。 */
  window.__probeWrite = async (mode) => {
    const fileService =
      mode === "old-remote"
        ? { writeBinaryFile: async () => { throw new Error("Method not found: fileService.writeBinaryFile"); } }
        : mode === "new-remote"
          ? { writeBinaryFile: async () => { throw new Error("File revision mismatch: /x (disk 10B/1 vs expected -1B/-1)"); } }
          : { writeBinaryFile: async () => ({ path: "/x", bytes: 0, revision: { size: 0, mtimeMs: 0 } }) };
    return await probeWriteSupport(fileService, "/x");
  };

  /** 批注框排版（纯函数，见 commentBalloons.ts）：重叠让位、按锚点排序、无锚点的排最后。 */
  window.__balloonCase = () =>
    layoutBalloons(
      [
        { id: "b", anchorTop: 40, height: 60 },
        { id: "a", anchorTop: 10, height: 60 },
        { id: "c", anchorTop: 60, height: 40 },
        { id: "d", anchorTop: null, height: 30 },
      ],
      { minTop: 0 },
    );
`;
