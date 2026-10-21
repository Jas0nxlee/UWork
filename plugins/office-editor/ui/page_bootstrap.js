// 装配最后执行：前面的 state、预览与编辑器声明全部初始化后再连接宿主。
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
