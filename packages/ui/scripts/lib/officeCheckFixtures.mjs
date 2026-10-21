/**
 * 行为检查用的**现场文档构造器**：造一份"难搞的" docx（修订/超链接/公式/批注/编号）。
 *
 * 为什么现场造而不是放二进制 fixture：这些特性用 XML 才看得清（评审能读 diff），
 * 而且 JSZip 生成是确定性的；二进制样本放在仓库里没人能 review 它的内容。
 */
export async function buildTrickyDocx() {
  const { default: JSZip } = await import("jszip");
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>` +
    "<w:p><w:r><w:t>AAA 普通正文</w:t></w:r></w:p>" +
    '<w:p><w:r><w:t>BBB</w:t></w:r><w:ins w:id="1" w:author="审阅者"><w:r><w:t>INSERTED</w:t></w:r></w:ins><w:r><w:t>CCC</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>DDD</w:t></w:r><w:del w:id="2" w:author="审阅者"><w:r><w:delText>DELETED</w:delText></w:r></w:del><w:r><w:t>EEE</w:t></w:r></w:p>' +
    '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>LINKTEXT</w:t></w:r></w:hyperlink></w:p>' +
    "<w:p><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></w:p>" +
    '<w:p><w:r><w:t>批注处</w:t></w:r><w:commentReference w:id="3"/></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>LIST-ITEM</w:t></w:r></w:p>' +
    "</w:body></w:document>";
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>',
  );
  zip.file("word/document.xml", document);
  return new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }));
}
