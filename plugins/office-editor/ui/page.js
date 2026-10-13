// office-editor 页面逻辑：经宿主官方 App 桥（ext-apps，内联在同一个 module 作用域）调用本插件工具。
// 页面只做展示与“发起工具调用”；读写都发生在插件工具里，走 Agent 的审批与审计路径。

const state = { path: null, busy: false };

const dom = {
  list: document.getElementById("list"),
  empty: document.getElementById("empty"),
  notice: document.getElementById("notice"),
  file: document.getElementById("file"),
  acceptAll: document.getElementById("accept-all"),
  rejectAll: document.getElementById("reject-all"),
  refresh: document.getElementById("refresh"),
};

function setBusy(busy) {
  state.busy = busy;
  for (const button of [dom.acceptAll, dom.rejectAll, dom.refresh]) {
    button.disabled = busy || !state.path;
  }
}

function applyTarget(payload) {
  if (!payload || typeof payload.path !== "string" || payload.path.length === 0) return false;
  state.path = payload.path;
  dom.file.textContent = payload.path;
  setBusy(false);
  void refresh();
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

function render(summary) {
  const revisions = summary?.revisions ?? [];
  dom.list.replaceChildren();
  dom.empty.hidden = revisions.length > 0;
  for (const revision of revisions) {
    const item = document.createElement("li");
    item.className = revision.kind;

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
    if (revision.table)
      parts.push(
        `表格 ${revision.table.index} 第 ${revision.table.row} 行第 ${revision.table.cell} 列`,
      );
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
    dom.list.append(item);
  }
  const comments = summary?.comments?.length ?? 0;
  dom.file.textContent = `${state.path ?? ""}${comments ? ` · 批注 ${comments} 条` : ""}`;
}

async function refresh() {
  if (!state.path || state.busy) return;
  setBusy(true);
  try {
    const result = await app.callServerTool({
      name: "docx_revisions_list",
      arguments: { path: state.path },
    });
    render(parseToolPayload(result));
  } finally {
    setBusy(false);
  }
}

async function resolve(action, ids) {
  if (!state.path || state.busy) return;
  setBusy(true);
  try {
    await app.callServerTool({
      name: "docx_revisions_resolve",
      arguments: { path: state.path, action, ids },
    });
    await refresh();
  } finally {
    setBusy(false);
  }
}

dom.refresh.addEventListener("click", () => void refresh());
dom.acceptAll.addEventListener("click", () => resolve("accept", null));
dom.rejectAll.addEventListener("click", () => resolve("reject", null));

function showNotice(message) {
  dom.notice.hidden = false;
  dom.notice.textContent = message;
}

const HOST_HANDSHAKE_TIMEOUT_MS = 5000;

if (typeof App === "undefined") {
  showNotice("宿主桥（MCP Apps）不可用：当前页面只能显示静态信息。请在客户端内打开本页面。");
  dom.file.textContent = "（宿主桥不可用）";
} else {
  const app = new App({ name: "office-editor", version: "0.1.0" });
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
    if (!state.path) {
      // 兜底：宿主可能已把"打开哪个文件"发完（通知早于本页面注册），直接问插件当前目标。
      const result = await app.callServerTool({ name: "docx_current_target", arguments: {} });
      if (!applyTarget(parseToolPayload(result))) {
        dom.file.textContent = "（未收到目标文件）";
        showNotice("请从对话里的工具卡片打开本页面的审阅视图：页面需要知道要审阅哪份文档。");
      }
    }
  } catch (error) {
    showNotice(`连接宿主失败：${error instanceof Error ? error.message : String(error)}`);
    dom.file.textContent = "（未连接宿主）";
  }
}
