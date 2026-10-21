// 预览分段：由 server.py 按顺序内联到与 page.js 同一个模块，复用其唯一 state 与 dom。
// —— 文档渲染 ——
// 字节与标记都走资源读（免审批）；渲染器 renderAsync 由服务端内联的 docx-preview 提供。

const DOCX_RESOURCE = "office://docx";
const RENDER_OPTIONS = {
  breakPages: true,
  experimental: true,
  inWrapper: true,
  // 文档是不可信数据：不渲染 altChunk（HTML/RTF 注入面），也不渲染批注气泡（我们有自己的批注区）。
  renderAltChunks: false,
  renderChanges: true,
  renderComments: false,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  ignoreLastRenderedPageBreak: true,
  ignoreFonts: false,
  useBase64URL: true,
};

function docxUri(params) {
  const query = new URLSearchParams(params);
  return `${DOCX_RESOURCE}?${query.toString()}`;
}

function base64ToBytes(blob) {
  const binary = atob(blob);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    merged.set(part, cursor);
    cursor += part.length;
  }
  return merged;
}

async function readResourceJson(uri) {
  const result = await app.readServerResource({ uri });
  const text = result?.contents?.[0]?.text;
  if (typeof text !== "string") throw new Error("资源返回体没有文本内容");
  return JSON.parse(text);
}

async function readResourceBytes(uri) {
  const result = await app.readServerResource({ uri });
  const blob = result?.contents?.[0]?.blob;
  if (typeof blob !== "string" || blob.length === 0) throw new Error("资源返回体没有字节内容");
  return base64ToBytes(blob);
}

function normalizeMarkText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

/** 把渲染出的 <ins>/<del> 与引擎标记对齐：数量一致按文档序贴 id，否则退化为文本前缀配对。 */
function alignMarks(payload) {
  const nodes = [...dom.docBody.querySelectorAll("ins,del")];
  const marks = Array.isArray(payload?.marks) ? payload.marks : [];
  let matched = 0;
  if (marks.length > 0 && nodes.length === marks.length) {
    nodes.forEach((node, index) => {
      node.dataset.revId = marks[index].id;
      node.title = `${marks[index].kind === "insert" ? "插入" : "删除"} · id=${marks[index].id}`;
      matched += 1;
    });
    return { total: marks.length, matched, mode: "order" };
  }
  const pool = marks.map((mark) => ({ ...mark, used: false }));
  for (const node of nodes) {
    const text = normalizeMarkText(node.textContent).slice(0, 40);
    if (!text) continue;
    const hit = pool.find((mark) => {
      if (mark.used) return false;
      const markText = normalizeMarkText(mark.text);
      return markText.startsWith(text) || text.startsWith(markText.slice(0, 20));
    });
    if (!hit) continue;
    hit.used = true;
    node.dataset.revId = hit.id;
    node.title = `${hit.kind === "insert" ? "插入" : "删除"} · id=${hit.id}`;
    matched += 1;
  }
  return { total: marks.length, matched, mode: "text" };
}

/** 窄面板里让纸张只缩小不放大（docx-preview 按 OOXML 原始页宽出图）。 */
function fitPreview() {
  const wrapper = dom.docBody.querySelector(".docx-wrapper");
  if (!wrapper) return;
  wrapper.style.transform = "";
  wrapper.style.transformOrigin = "top left";
  const available = dom.preview.clientWidth - 24;
  const natural = wrapper.scrollWidth;
  if (!available || !natural || natural <= available) return;
  const scale = available / natural;
  wrapper.style.transform = `scale(${scale})`;
  dom.docBody.style.height = `${Math.ceil(wrapper.scrollHeight * scale)}px`;
}

function locateRevision(id) {
  const node = dom.docBody.querySelector(`[data-rev-id="${CSS.escape(String(id))}"]`);
  if (!node) return false;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.dataset.revActive = "1";
  setTimeout(() => delete node.dataset.revActive, 2000);
  return true;
}

async function renderDocument() {
  if (!app || !state.path) return;
  if (typeof renderAsync !== "function") {
    showNotice("渲染器不可用：内联的 docx-preview 未加载，改用下方列表逐条处理。");
    return;
  }
  dom.preview.hidden = false;
  state.preview.shown = true;
  setBusy(true);
  try {
    hideNotice();
    setPreviewStatus("读取文件信息…");
    const meta = await readResourceJson(docxUri({ path: state.path, meta: "1" }));
    const parts = [];
    for (let offset = 0; offset < meta.size; offset += meta.chunkBytes) {
      setPreviewStatus(`读取分块 ${Math.floor(offset / meta.chunkBytes) + 1}/${meta.chunks}…`);
      parts.push(
        await readResourceBytes(
          docxUri({ path: state.path, offset, length: meta.chunkBytes, etag: meta.etag }),
        ),
      );
    }
    setPreviewStatus("渲染中…");
    dom.docStyles.replaceChildren();
    dom.docBody.replaceChildren();
    const bytes = concatBytes(parts);
    await renderAsync(bytes.buffer, dom.docBody, dom.docStyles, RENDER_OPTIONS);
    setPreviewStatus("对齐修订标记…");
    const marks = await readResourceJson(
      `${DOCX_RESOURCE}/marks?path=${encodeURIComponent(state.path)}&etag=${encodeURIComponent(meta.etag)}`,
    );
    const aligned = alignMarks(marks);
    fitPreview();
    state.preview.etag = meta.etag;
    setPreviewStatus(
      `已渲染 ${meta.chunks} 块 / ${Math.round(meta.size / 1024)} KiB · 修订 ${aligned.total} 处（对齐 ${aligned.matched}，${aligned.mode === "order" ? "按文档序" : "按文本"}）`,
    );
  } catch (error) {
    setPreviewStatus("");
    showNotice(`渲染文档失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

dom.previewToggle.addEventListener("click", () => {
  if (state.preview.shown) {
    state.preview.shown = false;
    dom.preview.hidden = true;
    return;
  }
  void renderDocument();
});

// 卡片里的小按钮：把同一个页面挪到侧边大窗口（页面实例不变，宿主换承载位置）。
dom.openSide.addEventListener("click", () => {
  if (!app?.requestDisplayMode) return;
  void Promise.resolve(app.requestDisplayMode({ mode: "fullscreen" }))
    .then(() => applyLayout())
    .catch((error) =>
      showNotice(`打开侧栏失败：${error instanceof Error ? error.message : String(error)}`),
    );
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  applyLayout();
  if (!state.preview.shown) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitPreview, 150);
});
