// office-editor 页面逻辑：经宿主官方 App 桥（ext-apps，内联在同一个 module 作用域）调用本插件工具。
// 页面只做展示与“发起工具调用”；读写都发生在插件工具里，走 Agent 的审批与审计路径。
//
// 大文档必须分页：宿主的工具结果有字节上限（content 32 KiB / structuredContent 64 KiB），
// 实测 1600 条修订一次性返回是 1061 KiB——服务端每页上限 40 条（≈25 KiB），页面按页取。
//
// 文档渲染（2026-10-15）：字节走资源读（office://docx，4 MiB 分块，不触发工具审批），
// 渲染器是内联的 docx-preview（renderChanges:true → <ins>/<del>），再用引擎的修订标记
// （office://docx/marks）把 DOM 节点与 w:id 对齐，实现「点列表 → 跳到文档对应位置」。

const state = {
  path: null,
  busy: false,
  offset: 0,
  limit: 25,
  total: 0,
  counts: null,
  comments: null, // null = 未加载（按需加载，少一次页面发起的工具调用）
  commentOffset: 0,
  preview: { shown: false, etag: null },
  editor: { active: null },
};

// 模块级持有：refresh/resolve 与宿主回调都要用它。放进 else 块里会让模块级函数取不到（真机踩坑）。
let app = null;

const dom = {
  list: document.getElementById("list"),
  empty: document.getElementById("empty"),
  notice: document.getElementById("notice"),
  file: document.getElementById("file"),
  totals: document.getElementById("totals"),
  pager: document.getElementById("pager"),
  pageLabel: document.getElementById("page-label"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  commentsToggle: document.getElementById("comments-toggle"),
  comments: document.getElementById("comments"),
  acceptAll: document.getElementById("accept-all"),
  rejectAll: document.getElementById("reject-all"),
  refresh: document.getElementById("refresh"),
  previewToggle: document.getElementById("preview-toggle"),
  openSide: document.getElementById("open-side"),
  editorBar: document.getElementById("editor-bar"),
  previewStatus: document.getElementById("preview-status"),
  preview: document.getElementById("doc-preview"),
  docBody: document.getElementById("doc-body"),
  docStyles: document.getElementById("doc-styles"),
};

// 产品规则（见 spec 二期）：审阅动作在对话卡片里做，文档预览与编辑在侧边大窗口做。
// 判据只认宿主上报的 displayMode——卡片所在的对话区本身可能很宽（实测 1010px），
// 按宽度猜会把卡片误判成大窗口，在卡片里渲染整篇文档。
function hostContext() {
  try {
    return app?.getHostContext?.() ?? null;
  } catch {
    return null;
  }
}

function applyLayout() {
  const mode = hostContext()?.displayMode;
  const wide = mode === "fullscreen";
  document.body.classList.toggle("wide", wide);
  dom.openSide.hidden = wide;
  dom.editorBar.hidden = !wide;
  // 侧栏＝Office 式编辑页：打开就把文档渲染出来并让段落可编辑；卡片里仍按需展开（只做接受/拒绝）。
  if (wide && state.path && !state.preview.shown && !state.busy) void renderDocument();
}

function showNotice(message) {
  dom.notice.hidden = false;
  dom.notice.textContent = message;
}

function hideNotice() {
  dom.notice.hidden = true;
}

function setBusy(busy) {
  state.busy = busy;
  dom.acceptAll.disabled = busy || !state.path;
  dom.rejectAll.disabled = busy || !state.path;
  dom.refresh.disabled = busy || !state.path;
  dom.commentsToggle.disabled = busy || !state.path;
  dom.previewToggle.disabled = busy || !state.path;
  dom.openSide.disabled = busy || !state.path;
  dom.prev.disabled = busy || !state.path || state.offset === 0;
  dom.next.disabled = busy || !state.path || state.offset + state.limit >= state.total;
}

function setPreviewStatus(text) {
  dom.previewStatus.textContent = text || "";
}

function applyTarget(payload) {
  if (!payload || typeof payload.path !== "string" || payload.path.length === 0) return false;
  if (state.path !== payload.path) {
    state.comments = null; // 换文件就丢掉旧的批注页
    state.preview = { shown: false, etag: null };
    dom.preview.hidden = true;
    dom.docBody.replaceChildren();
    dom.docStyles.replaceChildren();
    setPreviewStatus("");
  }
  state.path = payload.path;
  state.offset = 0;
  dom.file.textContent = payload.path;
  setBusy(false);
  void loadPage(0);
  applyLayout(); // 侧栏里打开时自动渲染文档；卡片里等用户点「显示文档」
  return true;
}

function parseToolPayload(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") return structured;
  const text = result?.content?.find?.((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function renderTotals(counts) {
  if (!counts) return;
  dom.totals.textContent = `插入 ${counts.insert ?? 0} · 删除 ${counts.delete ?? 0} · 批注 ${counts.comments ?? 0}`;
}

function renderRevision(revision) {
  const item = document.createElement("li");
  item.className = revision.kind;
  item.dataset.revId = revision.id;
  // 点条目 → 跳到文档里对应的 ins/del（点了按钮就不算定位需求）。
  item.addEventListener("click", (event) => {
    if (event.target?.closest?.("button")) return;
    if (locateRevision(revision.id)) return;
    if (state.preview.shown) {
      setPreviewStatus(`修订 id=${revision.id} 不在文档流中（可能在页眉/脚注/文本框内）。`);
    }
  });

  const row = document.createElement("div");
  row.className = "row";
  const kind = document.createElement("span");
  kind.className = `kind ${revision.kind}`;
  kind.textContent = revision.kind === "insert" ? "插入" : "删除";
  const actions = document.createElement("span");
  const accept = document.createElement("button");
  accept.textContent = "接受";
  accept.addEventListener("click", () => resolve("accept", [revision.id]));
  const reject = document.createElement("button");
  reject.textContent = "拒绝";
  reject.addEventListener("click", () => resolve("reject", [revision.id]));
  actions.append(accept, " ", reject);
  row.append(kind, actions);

  // 位置：只给"改了什么"不够——审阅者得知道在文档哪儿、周围是什么，才能判断该不该接受。
  const location = document.createElement("div");
  location.className = "loc";
  const parts = [`第 ${revision.paragraph ?? "?"} 段`];
  if (revision.table) {
    parts.push(
      `表格 ${revision.table.index} 第 ${revision.table.row} 行第 ${revision.table.cell} 列`,
    );
  }
  if (revision.nearestHeading?.text) parts.push(`「${revision.nearestHeading.text}」`);
  location.textContent = parts.join(" · ");

  const text = document.createElement("div");
  text.className = "text";
  const context = revision.context ?? { before: "", after: "" };
  if (context.before || context.after) {
    text.append(document.createTextNode(context.before ? `…${context.before}` : "…"));
    const mark = document.createElement("mark");
    mark.textContent = revision.text || "（无文本）";
    text.append(mark);
    text.append(document.createTextNode(context.after ? `${context.after}…` : "…"));
  } else {
    text.textContent = revision.text || "（无文本）";
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${revision.author || "未知作者"} · ${revision.date || ""} · id=${revision.id}`;

  item.append(row, location, text, meta);
  return item;
}

function renderComments(page) {
  dom.comments.replaceChildren();
  if (!page || page.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "没有批注。";
    dom.comments.append(empty);
    return;
  }
  const head = document.createElement("div");
  head.className = "comments-head";
  head.textContent = `批注 第 ${page.offset + 1}–${page.offset + page.items.length} / 共 ${page.total} 条`;
  dom.comments.append(head);
  for (const comment of page.items) {
    const row = document.createElement("div");
    row.className = "comment";
    const body = document.createElement("div");
    body.className = "comment-text";
    body.textContent = comment.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${comment.author || "未知作者"} · ${comment.date || ""} · id=${comment.id}`;
    row.append(body, meta);
    dom.comments.append(row);
  }
  const pager = document.createElement("div");
  pager.className = "comments-pager";
  const prev = document.createElement("button");
  prev.textContent = "上一页";
  prev.disabled = page.offset === 0;
  prev.addEventListener("click", () => void loadComments(Math.max(page.offset - page.limit, 0)));
  const next = document.createElement("button");
  next.textContent = "下一页";
  next.disabled = !page.hasMore;
  next.addEventListener("click", () => void loadComments(page.offset + page.limit));
  pager.append(prev, next);
  dom.comments.append(pager);
}

function render(page) {
  state.total = page.total;
  state.counts = page.counts;
  // 标题以"真的读到了哪个文件"为准：目标可能来自 ontoolinput/ontoolresult 或兜底工具，
  // 任一路径成功都要把标题纠正过来（否则会出现"列表有数据、标题说未收到目标"）。
  if (state.path) dom.file.textContent = state.path;
  renderTotals(page.counts);
  dom.list.replaceChildren();
  dom.empty.hidden = page.items.length > 0;
  for (const revision of page.items) dom.list.append(renderRevision(revision));
  dom.pager.hidden = page.total === 0;
  dom.pageLabel.textContent =
    page.total === 0
      ? ""
      : `第 ${page.offset + 1}–${page.offset + page.items.length} / 共 ${page.total} 条`;
  setBusy(false);
}

async function loadPage(offset) {
  if (!app || !state.path || state.busy) return;
  setBusy(true);
  try {
    const result = await app.callServerTool({
      name: "docx_revisions_list",
      arguments: { path: state.path, offset, limit: state.limit },
    });
    const page = parseToolPayload(result);
    if (!page || !Array.isArray(page.items)) {
      showNotice("列出修订失败：返回体不是可解析的分页数据。");
      return;
    }
    hideNotice();
    state.offset = page.offset;
    render(page);
  } catch (error) {
    showNotice(`列修订失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

async function loadComments(offset) {
  if (!app || !state.path || state.busy) return;
  setBusy(true);
  try {
    const result = await app.callServerTool({
      name: "docx_comments_list",
      arguments: { path: state.path, offset, limit: state.limit },
    });
    const page = parseToolPayload(result);
    if (!page || !Array.isArray(page.items)) {
      showNotice("加载批注失败：返回体不是可解析的分页数据。");
      return;
    }
    state.comments = page;
    state.commentOffset = page.offset;
    renderComments(page);
  } catch (error) {
    showNotice(`加载批注失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

async function resolve(action, ids) {
  if (!app || !state.path || state.busy) return;
  setBusy(true);
  try {
    await app.callServerTool({
      name: "docx_revisions_resolve",
      arguments: { path: state.path, action, ids },
    });
    state.busy = false;
    await loadPage(state.offset);
    if (state.comments) await loadComments(state.commentOffset);
    // 接受/拒绝改的是真实文件：渲染中的文档必须重读重渲染，否则页面与磁盘不一致。
    if (state.preview.shown) await renderDocument();
  } catch (error) {
    showNotice(`处理修订失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

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
      parts.push(await readResourceBytes(docxUri({ path: state.path, offset, length: meta.chunkBytes })));
    }
    setPreviewStatus("渲染中…");
    dom.docStyles.replaceChildren();
    dom.docBody.replaceChildren();
    const bytes = concatBytes(parts);
    await renderAsync(bytes.buffer, dom.docBody, dom.docStyles, RENDER_OPTIONS);
    setPreviewStatus("对齐修订标记…");
    const marks = await readResourceJson(`${DOCX_RESOURCE}/marks?path=${encodeURIComponent(state.path)}`);
    const aligned = alignMarks(marks);
    fitPreview();
    state.preview.etag = meta.etag;
    setPreviewStatus(
      `已渲染 ${meta.chunks} 块 / ${Math.round(meta.size / 1024)} KiB · 修订 ${aligned.total} 处（对齐 ${aligned.matched}，${aligned.mode === "order" ? "按文档序" : "按文本"}）`,
    );
    // 侧栏＝编辑位：渲染完就把段落变成可编辑区（卡片里不做编辑，只做接受/拒绝）。
    if (document.body.classList.contains("wide")) await enableEditing();
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
    .catch((error) => showNotice(`打开侧栏失败：${error instanceof Error ? error.message : String(error)}`));
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  applyLayout();
  if (!state.preview.shown) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitPreview, 150);
});

// —— 编辑（侧栏＝Office 式编辑页；卡片里不做编辑）——
// 段落与引擎段号按文档序对齐，但**文本必须对得上**才允许编辑：对不上就不动它（宁可不给编辑，也不改错段落）。

async function enableEditing() {
  if (!state.path) return;
  const payload = await readResourceJson(
    `${DOCX_RESOURCE}/paragraphs?path=${encodeURIComponent(state.path)}`,
  );
  const paragraphs = Array.isArray(payload?.paragraphs) ? payload.paragraphs : [];
  const nodes = [...dom.docBody.querySelectorAll("p")].filter((node) => !node.closest("header, footer"));
  let editable = 0;
  let skipped = 0;
  nodes.forEach((node, position) => {
    const item = paragraphs[position];
    const domText = normalizeMarkText(node.textContent).slice(0, 60);
    const engineText = normalizeMarkText(item?.text ?? "").slice(0, 60);
    const aligned =
      Boolean(item) &&
      (domText.startsWith(engineText.slice(0, 20)) || engineText.startsWith(domText.slice(0, 20)));
    if (!aligned) {
      skipped += 1;
      return;
    }
    node.dataset.paragraph = String(item.index);
    node.dataset.originalText = node.textContent ?? "";
    node.setAttribute("contenteditable", "plaintext-only");
    node.addEventListener("focus", () => {
      state.editor.active = node;
    });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        node.blur();
      }
      if (event.key === "Escape") {
        node.textContent = node.dataset.originalText ?? "";
        node.blur();
      }
    });
    node.addEventListener("blur", () => void commitParagraph(node));
    editable += 1;
  });
  setPreviewStatus(
    `编辑就绪：${editable} 段可编辑${skipped ? ` · ${skipped} 段未对齐（不在编辑范围）` : ""}；点段落改字，⌘↵ 保存，Esc 放弃`,
  );
}

async function commitParagraph(node) {
  const paragraph = Number(node.dataset.paragraph);
  const text = node.textContent ?? "";
  const original = node.dataset.originalText ?? "";
  if (!Number.isFinite(paragraph) || text === original) return;
  setPreviewStatus(`写入第 ${paragraph} 段…`);
  try {
    const result = await app.callServerTool({
      name: "docx_edit_paragraph",
      arguments: { path: state.path, paragraph, text },
    });
    const output = parseToolPayload(result);
    if (result?.isError) throw new Error(output ? JSON.stringify(output) : "工具返回错误");
    const backupName = output?.backup ? String(output.backup).split("/").pop() : "";
    setPreviewStatus(
      `第 ${paragraph} 段已写入${output?.tracked === false ? "（直接改写）" : "（记为修订，可在对话卡片里接受/拒绝）"}${backupName ? ` · 备份 ${backupName}` : ""}`,
    );
    await renderDocument(); // 重读重渲染：修订标记与段落文本都跟着更新
  } catch (error) {
    node.textContent = original;
    showNotice(`写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function applyParagraphFormat(patch) {
  const node = state.editor.active;
  const paragraph = Number(node?.dataset?.paragraph);
  if (!Number.isFinite(paragraph)) {
    showNotice("先点一下要设置格式的段落。");
    return;
  }
  setPreviewStatus(`设置第 ${paragraph} 段格式…`);
  try {
    const result = await app.callServerTool({
      name: "docx_set_paragraph_format",
      arguments: { path: state.path, paragraph, ...patch },
    });
    const output = parseToolPayload(result);
    if (result?.isError) throw new Error(output ? JSON.stringify(output) : "工具返回错误");
    setPreviewStatus(`第 ${paragraph} 段格式已更新`);
    await renderDocument();
  } catch (error) {
    showNotice(`设置格式失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const button of document.querySelectorAll("#editor-bar [data-fmt]")) {
  const flag = button.dataset.fmt;
  button.addEventListener("click", () => {
    const node = state.editor.active;
    // 文档里的真实格式尚未回读，这里按点击次数在 true/false 间切换（v1 近似）。
    const next = node?.dataset[`fmt${flag}`] !== "1";
    if (node) node.dataset[`fmt${flag}`] = next ? "1" : "0";
    void applyParagraphFormat({ [flag]: next });
  });
}

for (const button of document.querySelectorAll("#editor-bar [data-align]")) {
  const align = button.dataset.align;
  button.addEventListener("click", () => void applyParagraphFormat({ align }));
}

dom.refresh.addEventListener("click", () => void loadPage(state.offset));
dom.prev.addEventListener("click", () => void loadPage(Math.max(state.offset - state.limit, 0)));
dom.next.addEventListener("click", () => void loadPage(state.offset + state.limit));
dom.acceptAll.addEventListener("click", () => resolve("accept", null));
dom.rejectAll.addEventListener("click", () => resolve("reject", null));
dom.commentsToggle.addEventListener("click", () => void loadComments(0));

const HOST_HANDSHAKE_TIMEOUT_MS = 5000;

if (typeof App === "undefined") {
  showNotice("宿主桥（MCP Apps）不可用：当前页面只能显示静态信息。请在客户端内打开本页面。");
  dom.file.textContent = "（宿主桥不可用）";
} else {
  app = new App({ name: "office-editor", version: "0.2.0" });
  // 宿主切换承载位置（卡片 ↔ 侧栏/fullscreen）会推 hostcontext：布局跟着切，侧栏里自动渲染。
  app.onhostcontextchanged = () => applyLayout();
  // 宿主在工具完成后才挂载页面：先是工具输入（参数里就带 path），再是工具结果；
  // 两者都可能在本页面注册之前发生，所以连上之后还有一次"向插件要当前目标"的兜底。
  app.ontoolinput = (params) => {
    const path = params?.arguments?.path;
    if (typeof path === "string") applyTarget({ path });
  };
  app.ontoolresult = (params) => {
    const payload = params?.structuredContent ?? params?.toolOutput ?? null;
    applyTarget(payload);
  };
  try {
    // 宿主不在或握手不响应时（例如把页面当普通网页打开）必须给回退提示，而不是永远停在灰按钮。
    await Promise.race([
      app.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("宿主未在 5 秒内完成握手")), HOST_HANDSHAKE_TIMEOUT_MS),
      ),
    ]);
    setBusy(false);
    applyLayout();
    if (!state.path) {
      // 兜底：宿主可能已把"打开哪个文件"发完（通知早于本页面注册），直接问插件当前目标。
      const result = await app.callServerTool({ name: "docx_current_target", arguments: {} });
      // 等待期间迟到的 ontoolinput/ontoolresult 可能已经把目标设好：这时不能再把标题冲回占位文案，
      // 也不能再报"请从卡片打开"（真机：列表已有 25 条而标题写着"未收到目标文件"）。
      if (!applyTarget(parseToolPayload(result)) && !state.path) {
        dom.file.textContent = "（未收到目标文件）";
        showNotice("请从对话里的工具卡片打开本页面的审阅视图：页面需要知道要审阅哪份文档。");
      }
    }
  } catch (error) {
    showNotice(`连接宿主失败：${error instanceof Error ? error.message : String(error)}`);
    dom.file.textContent = "（未连接宿主）";
  }
}
