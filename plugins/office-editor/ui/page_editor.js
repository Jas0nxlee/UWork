// 编辑器分段：实例、目标与加载版本仍由 page.js 的唯一 state 拥有。
// —— 侧栏＝内嵌的 Office 编辑器（SuperDoc，UMD 全局 `SuperDoc`，随页面内联）——
// 分工：卡片做接受/拒绝（我们的引擎），侧栏做真正的文档编辑（成熟引擎），保存整份写回原文件。

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_WRITE_BACK_BASE64_BYTES = 8 * 1024 * 1024;

function setEditorStatus(text) {
  if (dom.editorStatus) dom.editorStatus.textContent = text || "";
}

function fileNameOf(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || "document.docx";
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

async function loadDocxBytes(path) {
  const meta = await readResourceJson(docxUri({ path, meta: "1" }));
  const parts = [];
  for (let offset = 0; offset < meta.size; offset += meta.chunkBytes) {
    setEditorStatus(`读取文档 ${Math.floor(offset / meta.chunkBytes) + 1}/${meta.chunks}…`);
    parts.push(
      await readResourceBytes(docxUri({ path, offset, length: meta.chunkBytes, etag: meta.etag })),
    );
  }
  const current = await readResourceJson(docxUri({ path, meta: "1" }));
  if (current.etag !== meta.etag) throw new Error("读取期间文件已变化，请重载文档。");
  return { bytes: concatBytes(parts), meta };
}

function resetEditor() {
  state.editorGeneration += 1;
  try {
    state.editorInstance?.destroy?.();
  } catch {
    /* 旧实例不可再写回，销毁失败仍清除绑定。 */
  }
  state.editorInstance = null;
  state.editorPath = null;
  state.editorEtag = null;
  state.editorLoading = false;
  state.editorReady = false;
  globalThis.__officeEditor = null;
  dom.superdocHost.replaceChildren();
  dom.editorSave.disabled = true;
}

async function mountEditor(options = {}) {
  if (!state.path) return;
  if (options.force) resetEditor();
  if (state.editorInstance || state.editorLoading) return;
  const path = state.path;
  const generation = state.editorGeneration;
  const isCurrent = () => state.path === path && state.editorGeneration === generation;
  state.editorLoading = true;
  dom.editorSave.disabled = true;
  // 引擎地址来自插件配置（office://superdoc/config）：内网镜像时由它设置全局，
  // 未配置则直接给出可执行的结论，而不是让它去联网失败后再白屏。
  try {
    const config = await readResourceJson("office://superdoc/config");
    if (!isCurrent()) return;
    if (config?.baseUrl) {
      globalThis.SUPERDOC_ENGINE_CDN_BASE_URL = config.baseUrl;
      setEditorStatus(`使用内网引擎镜像：${config.baseUrl}`);
    } else {
      state.editorUnavailable = true;
      setEditorStatus(
        "Office 编辑器未配置引擎镜像（engine.json 的 baseUrl 为空），已回落到只读预览。",
      );
      applyLayout();
      return;
    }
    if (typeof SuperDoc === "undefined") throw new Error("Office 编辑器内联包不可用");
    const { bytes, meta } = await loadDocxBytes(path);
    if (!isCurrent()) return;
    setEditorStatus("启动 Office 编辑器…");
    // 官方就绪信号是 onReady 回调；错误走 onContentError/onException（不接这两个回调，
    // 页面表现就是"状态说就绪、画布全白"——真机踩过，测了半轮才发现错误被回调吃掉了）。
    const ready = { done: false, error: "" };
    let settled;
    const readyPromise = new Promise((resolve) => {
      settled = resolve;
    });
    const instance = new SuperDoc({
      selector: "#superdoc-host",
      document: new File([bytes], fileNameOf(path), { type: DOCX_MIME }),
      // 默认按修订记录改动：编辑结果在 Word 里仍是"未接受的修订"，可回到卡片逐条接受/拒绝。
      modules: { trackChanges: true },
      onReady: () => {
        ready.done = true;
        settled();
      },
      onContentError: ({ error }) => {
        ready.error = `内容错误：${error?.message ?? String(error)}`;
        settled();
      },
      onException: ({ error }) => {
        ready.error = `异常：${error?.message ?? String(error)}`;
        settled();
      },
    });
    state.editorInstance = instance;
    globalThis.__officeEditor = instance;
    let timeout;
    try {
      await Promise.race([
        readyPromise,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (!isCurrent()) return;
    if (ready.error) throw new Error(ready.error);
    // ready 是对象，旧代码判断对象真值导致超时白屏仍提示就绪；只接受明确 onReady。
    if (!ready.done) throw new Error("编辑器启动超时，请重载或使用只读预览。");
    state.editorPath = path;
    state.editorEtag = meta.etag;
    state.editorReady = true;
    dom.editorSave.disabled = false;
    setEditorStatus(
      `编辑器就绪 · ${Math.round(meta.size / 1024)} KiB · 改动默认记为修订；点「保存到文件」写回原文件`,
    );
  } catch (error) {
    if (!isCurrent()) return;
    resetEditor();
    const message = error instanceof Error ? error.message : String(error);
    // 引擎不可用（无外网/未配置内网镜像）不是白屏：标记后回落到只读预览，并把原因写清楚。
    state.editorUnavailable = true;
    setEditorStatus(`Office 编辑器不可用：${message}`);
    showNotice(
      `Office 编辑器引擎不可用：${message}。当前在侧栏回落到只读预览；审阅请回到对话卡片逐条接受或拒绝。`,
    );
    applyLayout();
  } finally {
    if (isCurrent()) state.editorLoading = false;
  }
}

/** 从编辑器实例导出 docx：方法名在不同版本间有差异，逐个试并把结果归一成 Blob。 */
async function exportDocxBlob(instance) {
  for (const name of ["exportDocx", "export", "getFile", "save", "getDocument"]) {
    const fn = instance?.[name];
    if (typeof fn !== "function") continue;
    try {
      const value = await fn.call(instance, name === "save" ? { format: "docx" } : undefined);
      if (value instanceof Blob) return value;
      if (value?.blob instanceof Blob) return value.blob;
      if (value?.file instanceof Blob) return value.file;
      if (value instanceof ArrayBuffer) return new Blob([value], { type: DOCX_MIME });
      if (value instanceof Uint8Array) return new Blob([value], { type: DOCX_MIME });
    } catch {
      // 该名字不是导出 API：继续试下一个
    }
  }
  return null;
}

async function saveEditor() {
  const instance = state.editorInstance;
  const path = state.editorPath;
  const etag = state.editorEtag;
  const generation = state.editorGeneration;
  const isCurrent = () =>
    state.path === path &&
    state.editorGeneration === generation &&
    state.editorInstance === instance;
  if (!instance || !state.editorReady || !path || !etag || !isCurrent()) return;
  try {
    setEditorStatus("导出 docx…");
    const blob = await exportDocxBlob(instance);
    if (!blob) {
      const methods = Object.keys(instance).filter((key) => typeof instance[key] === "function");
      throw new Error(
        `编辑器没有返回文档内容（可用方法：${methods.slice(0, 12).join(", ") || "无"}）`,
      );
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // 导出是异步操作；期间换文件后必须丢弃旧结果，不能使用此刻的 state.path 重新选目标。
    if (!isCurrent()) return;
    // 服务端校验发生在帧接收后；页面必须先限制 base64 大小，才能避免超过 stdio 10 MiB 上限。
    if (4 * Math.ceil(bytes.length / 3) > MAX_WRITE_BACK_BASE64_BYTES) {
      throw new Error("整份保存超过 6 MiB 文档上限，暂不支持分块保存。");
    }
    setEditorStatus(`写回文件（${Math.round(bytes.length / 1024)} KiB）…`);
    const result = await app.callServerTool({
      name: "docx_write_back",
      arguments: { path, data: bytesToBase64(bytes), expectedEtag: etag },
    });
    if (!isCurrent()) return;
    const output = parseToolPayload(result);
    if (result?.isError) throw new Error(output ? JSON.stringify(output) : "写回失败");
    state.editorEtag = output?.etag;
    const backupName = output?.backup ? String(output.backup).split("/").pop() : "";
    const counts = output?.counts ?? {};
    setEditorStatus(
      `已保存到 ${state.path}${backupName ? ` · 备份 ${backupName}` : ""} · 剩余修订：插入 ${counts.insert ?? 0} / 删除 ${counts.delete ?? 0}`,
    );
    void loadPage(state.offset); // 卡片里的审阅列表跟着刷新
  } catch (error) {
    if (!isCurrent()) return;
    setEditorStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

dom.editorSave?.addEventListener("click", () => void saveEditor());
dom.editorReload?.addEventListener("click", () => void mountEditor({ force: true }));
