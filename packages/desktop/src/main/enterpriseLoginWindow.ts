import { randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { enterpriseLoginPopupRequestSchema, readEnterpriseIdentityCallback } from "@zcode/shared";
import { classifyEnterpriseLoginNavigation } from "./enterpriseLoginNavigation.js";

interface LoginWindowRoute {
  id: string;
  window: BrowserWindow;
  result: Promise<string | null>;
  cancel(): void;
}
const windows = new Map<number, LoginWindowRoute>();

/** Main 只保存 native window handle 和短期回调路由，身份事实仍在 Host。 */
export function openEnterpriseLoginWindow(
  event: Pick<IpcMainInvokeEvent, "sender">,
  raw: unknown,
): Promise<string | null> {
  const request = enterpriseLoginPopupRequestSchema.parse(raw);
  const remaining = request.expiresAt - Date.now();
  if (remaining <= 0 || remaining > 600000) throw new Error("Enterprise login request expired");
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || parent.isDestroyed()) throw new Error("Enterprise login window owner unavailable");
  const ownerId = event.sender.id;
  const previous = windows.get(ownerId);
  if (previous?.id === request.id && !previous.window.isDestroyed()) {
    previous.window.focus();
    return previous.result;
  }
  previous?.cancel();
  const partition = `uwork-enterprise-login-${randomUUID()}`;
  const window = new BrowserWindow({
    parent,
    width: 540,
    height: 560,
    minWidth: 400,
    minHeight: 480,
    show: false,
    title: "UWork · 企业微信登录",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition,
      webSecurity: true,
      devTools: false,
    },
  });
  const privateSession = window.webContents.session;
  privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  privateSession.setPermissionCheckHandler(() => false);
  privateSession.on("will-download", (event) => event.preventDefault());
  let settled = false;
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
    parent.removeListener("closed", cancel);
    if (windows.get(ownerId)?.window === window) windows.delete(ownerId);
    if (!window.isDestroyed()) window.destroy();
    // 登录页使用内存 partition；完成/取消后异步清理，不触及用户的普通浏览器会话。
    void privateSession.clearStorageData().catch(() => {});
    if (error) reject(error);
    else resolve(value);
  };
  const cancel = () => finish(null);
  const timer = setTimeout(cancel, remaining);
  windows.set(ownerId, { id: request.id, window, result, cancel });
  parent.once("closed", cancel);
  window.once("closed", cancel);
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
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
      // 停止回调网页加载，避免网页先消费一次性 code；只把 URL 转发给原窗口的 Host。
      finish(url);
    } catch {
      finish(null, new Error("Enterprise login callback rejected"));
    }
  };
  window.webContents.on("will-frame-navigate", (event) => {
    // 官方登录组件可能从 iframe 回传；只对精确绑定的回调拦截，验证规则不因 frame 放宽。
    if (event.isMainFrame || classifyEnterpriseLoginNavigation(event.url, request) === "callback")
      navigate(event, event.url);
  });
  window.webContents.on("will-redirect", (event) => {
    if (event.isMainFrame || classifyEnterpriseLoginNavigation(event.url, request) === "callback")
      navigate(event, event.url);
  });
  window.webContents.on("render-process-gone", () =>
    finish(null, new Error("Enterprise login page closed")),
  );
  void window.loadURL(request.authorizationUrl).catch(() => {
    if (!settled) finish(null, new Error("Unable to open enterprise login"));
  });
  return result;
}

export function cancelEnterpriseLoginWindow(ownerId: number, attemptId: unknown): void {
  if (typeof attemptId !== "string") return;
  const route = windows.get(ownerId);
  if (route?.id === attemptId) route.cancel();
}
