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
  editorInstance: null,
  editorPath: null,
  editorEtag: null,
  editorGeneration: 0,
  editorLoading: false,
  editorReady: false,
  editorUnavailable: false,
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
  editorSave: document.getElementById("editor-save"),
  editorReload: document.getElementById("editor-reload"),
  editorStatus: document.getElementById("editor-status"),
  superdocHost: document.getElementById("superdoc-host"),
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
  if (wide) {
    if (state.editorUnavailable) {
      // 引擎不可用（如无外网/未配置内网镜像）：侧栏回落到我们自己渲染的只读预览，绝不留白屏。
      dom.superdocHost.hidden = true;
      dom.preview.hidden = false;
      if (!state.preview.shown && !state.busy) void renderDocument();
    } else {
      dom.preview.hidden = true;
      dom.superdocHost.hidden = false;
      void mountEditor();
    }
  } else {
    dom.superdocHost.hidden = true;
  }
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
    // 实例和加载版本属于同一个目标；只改 path 会把旧实例 A 的内容保存到新目标 B。
    resetEditor();
    state.editorUnavailable = false;
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
