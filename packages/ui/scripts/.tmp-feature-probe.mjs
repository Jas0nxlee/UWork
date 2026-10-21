/** 临时探针：特性矩阵的导入/导出存活情况（review 用，事后删除）。 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { engineAssetPaths, startOfficeHarness } from "./lib/officeEditorHarness.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const assets = engineAssetPaths(repoRoot);
const HARNESS = `<!doctype html><meta charset="utf-8"><div id="host" style="height:100vh"></div>
<script type="importmap">{"imports":{"@hufe921/canvas-editor":"/ce/canvas-editor.js"}}</script>
<script type="module">
  import Editor from "/ce/canvas-editor.js";
  import docxPlugin from "/ce/docx.js";
  window.__load = async (url) => {
    document.getElementById("host").replaceChildren();
    const editor = new Editor(document.getElementById("host"), { main: [{ value: "" }] }, { pageMode: "paging", scrollContainerSelector: "#host" });
    editor.use(docxPlugin);
    await editor.command.executeImportDocx({ arrayBuffer: await (await fetch(url)).arrayBuffer() });
    window.__editor = editor;
    return true;
  };
  window.__text = () => window.__editor.command.getValue().data.main.map((e) => e.value ?? "").join("");
  window.__export = async () => {
    const blob = await window.__editor.command.executeExportDocx({ fileName: "out.docx" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ""; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };
</script>`;
const harness = await startOfficeHarness({
  prefix: "office-feature-probe-",
  pages: { "index.html": HARNESS },
  copies: {
    [assets.engine]: "ce/canvas-editor.js",
    [assets.docxPlugin]: "ce/docx.js",
    "/tmp/oe-feat2/features2.docx": "features2.docx",
  },
});
await harness.page.evaluate(() => window.__load("/features2.docx"));
const text = await harness.page.evaluate(() => window.__text());
console.log("导入后的文本:", JSON.stringify(text));
const base64 = await harness.page.evaluate(() => window.__export());
writeFileSync(join(harness.dir, "exported.docx"), Buffer.from(base64, "base64"));
console.log("导出文件:", join(harness.dir, "exported.docx"));
await harness.close();
