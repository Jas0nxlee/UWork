import { randomUUID } from "node:crypto";
import { BrowserWindow, WebContentsView, type IpcMainInvokeEvent } from "electron";
import {
  enterpriseLoginRequestSchema,
  enterpriseLoginSurfaceUpdateSchema,
  readEnterpriseIdentityCallback,
  type EnterpriseLoginSurface,
} from "@zcode/shared";
import { classifyEnterpriseLoginNavigation } from "./enterpriseLoginNavigation.js";
import {
  createEnterpriseEmbedCss,
  createEnterpriseFrameStyleScript,
  createEnterpriseEmbedUrl,
  fitEnterpriseSurfaceBounds,
} from "./enterpriseLoginSurface.js";

interface LoginViewRoute {
  id: string;
  view: WebContentsView;
  result: Promise<string | null>;
  update(surface: EnterpriseLoginSurface | null): void;
  cancel(): void;
}
const views = new Map<number, LoginViewRoute>();

/** Main 只保存原窗口内的 guest view 和短期回调路由，身份事实仍在 Host。 */
export function openEnterpriseLoginView(
  event: Pick<IpcMainInvokeEvent, "sender">,
  raw: unknown,
): Promise<string | null> {
  const request = enterpriseLoginRequestSchema.parse(raw);
  const remaining = request.expiresAt - Date.now();
  if (remaining <= 0 || remaining > 600000) throw new Error("Enterprise login request expired");
  const owner = event.sender;
  const parent = BrowserWindow.fromWebContents(owner);
  if (!parent || parent.isDestroyed()) throw new Error("Enterprise login view owner unavailable");
  const previous = views.get(owner.id);
  if (previous?.id === request.id && !previous.view.webContents.isDestroyed()) {
    previous.update(request.surface);
    return previous.result;
  }
  previous?.cancel();
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: `uwork-enterprise-login-${randomUUID()}`,
      webSecurity: true,
      devTools: false,
    },
  });
  view.setBackgroundColor("#00000000");
  const guest = view.webContents;
  const privateSession = guest.session;
  privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  privateSession.setPermissionCheckHandler(() => false);
  privateSession.on("will-download", (event) => event.preventDefault());
  let settled = false;
  let surface: EnterpriseLoginSurface | null = request.surface;
  let styleTask: Promise<void> = Promise.resolve();
  let loaded = false;
  // 授权页原始布局先于固定样式出现：直接显示会先露出一屏未适配的网页再跳到二维码。
  // 首次显示必须等该文档的样式写入完成，之后不再隐藏，避免重载/刷新二维码时二次闪烁。
  let revealed = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledCss: string | null = null;
  let documentGeneration = 0;
  let resolve!: (value: string | null) => void;
  let reject!: (reason: Error) => void;
  const result = new Promise<string | null>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const finish = (value: string | null, error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (revealTimer) clearTimeout(revealTimer);
    clearTimeout(revealDeadline);
    parent.removeListener("closed", cancel);
    parent.removeListener("resize", place);
    owner.removeListener("destroyed", cancel);
    owner.removeListener("did-start-navigation", ownerNavigation);
    if (views.get(owner.id)?.view === view) views.delete(owner.id);
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
    if (!guest.isDestroyed()) guest.close();
    if (!owner.isDestroyed()) owner.focus();
    void privateSession.clearStorageData().catch(() => {});
    if (error) reject(error);
    else resolve(value);
  };
  const cancel = () => finish(null);
  const place = () => {
    if (settled || parent.isDestroyed() || owner.isDestroyed()) return;
    if (!surface) {
      view.setVisible(false);
      return;
    }
    const zoom = owner.getZoomFactor();
    const content = parent.getContentBounds();
    const bounds = fitEnterpriseSurfaceBounds(surface.bounds, zoom, [
      content.width,
      content.height,
    ]);
    view.setBounds(bounds);
    guest.setZoomFactor(zoom);
    view.setVisible(revealed && bounds.width > 0 && bounds.height > 0);
  };
  const reveal = () => {
    if (settled || revealed) return;
    revealed = true;
    place();
    style(true);
  };
  const scheduleReveal = () => {
    if (settled || revealed || revealTimer) return;
    // 样式写入完成后再等一帧：二维码图片仍需绘制，过早显示会看到半成品布局。
    revealTimer = setTimeout(() => {
      revealTimer = null;
      reveal();
    }, 200);
  };
  const style = (force = false) => {
    if (!loaded || !surface || settled) return;
    const css = createEnterpriseEmbedCss(surface.appearance);
    if (!force && css === scheduledCss) return;
    scheduledCss = css;
    const generation = documentGeneration;
    // 主题变更只替换样式，不重载二维码；串行处理避免旧主题覆盖新的外观。
    styleTask = styleTask
      .then(async () => {
        if (settled || guest.isDestroyed() || generation !== documentGeneration) return;
        const script = createEnterpriseFrameStyleScript(css);
        for (const frame of guest.mainFrame.framesInSubtree) {
          if (settled || guest.isDestroyed() || generation !== documentGeneration) return;
          if (
            frame.isDestroyed() ||
            classifyEnterpriseLoginNavigation(frame.url, request) !== "authorization"
          )
            continue;
          try {
            await frame.executeJavaScript(script);
          } catch {
            if (!frame.isDestroyed() && generation === documentGeneration && !settled)
              throw new Error("Enterprise frame style unavailable");
          }
        }
      })
      .catch(() => {
        if (!settled && generation === documentGeneration)
          finish(null, new Error("Unable to style enterprise login"));
      });
  };
  const update = (next: EnterpriseLoginSurface | null) => {
    surface = next;
    place();
    style();
  };
  const ownerNavigation = (
    _event: unknown,
    _url: string,
    _inPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) cancel();
  };
  const timer = setTimeout(cancel, remaining);
  // 样式通道异常（帧销毁、脚本注入失败）时不能让二维码一直不可见：到期直接显示。
  const revealDeadline = setTimeout(reveal, 4000);
  views.set(owner.id, { id: request.id, view, result, update, cancel });
  parent.contentView.addChildView(view);
  parent.once("closed", cancel);
  parent.on("resize", place);
  owner.once("destroyed", cancel);
  owner.on("did-start-navigation", ownerNavigation);
  guest.setWindowOpenHandler(() => ({ action: "deny" }));
  guest.on("will-attach-webview", (event) => event.preventDefault());
  guest.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  const navigate = (event: { preventDefault(): void }, url: string) => {
    const route = classifyEnterpriseLoginNavigation(url, request);
    if (route === "authorization") return;
    event.preventDefault();
    if (route === "blocked") {
      finish(null, new Error("Enterprise login navigation blocked"));
      return;
    }
    try {
      readEnterpriseIdentityCallback(request, url);
      // 停止回调网页加载，避免其先消费一次性 code；仍只交给原 Host 校验。
      finish(url);
    } catch {
      finish(null, new Error("Enterprise login callback rejected"));
    }
  };
  guest.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || classifyEnterpriseLoginNavigation(event.url, request) === "callback")
      navigate(event, event.url);
  });
  guest.on("will-redirect", (event) => {
    if (event.isMainFrame || classifyEnterpriseLoginNavigation(event.url, request) === "callback")
      navigate(event, event.url);
  });
  guest.on("render-process-gone", () => finish(null, new Error("Enterprise login page closed")));
  guest.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    // 新版登录页在 iframe 内绘制扫码卡片；文档导航后固定样式节点需重新创建。
    documentGeneration++;
    loaded = false;
    scheduledCss = null;
  });
  guest.on("did-finish-load", () => {
    loaded = true;
    // Electron 导航提交会恢复新 origin 的 zoom；每个授权文档加载后重新同步 UI 缩放。
    place();
    style(true);
    // 首次显示与本文档的固定样式绑定：样式写入完成后再显示，避免露出未适配的页面。
    if (!revealed) {
      const pending = styleTask;
      void pending.then(
        () => scheduleReveal(),
        () => undefined,
      );
    }
  });
  guest.on("did-frame-finish-load", () => {
    // 包括异步挂载和重载的授权子 frame；只对官方白名单 frame 做固定样式写入。
    if (loaded) style(true);
  });
  place();
  void guest.loadURL(createEnterpriseEmbedUrl(request)).catch(() => {
    if (!settled) finish(null, new Error("Unable to open enterprise login"));
  });
  return result;
}

export function updateEnterpriseLoginView(ownerId: number, raw: unknown): void {
  const parsed = enterpriseLoginSurfaceUpdateSchema.safeParse(raw);
  if (!parsed.success) return;
  const route = views.get(ownerId);
  if (route?.id === parsed.data.id) route.update(parsed.data.surface);
}
export function cancelEnterpriseLoginView(ownerId: number, attemptId: unknown): void {
  if (typeof attemptId !== "string") return;
  const route = views.get(ownerId);
  if (route?.id === attemptId) route.cancel();
}
