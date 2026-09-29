import type { EnterpriseLoginAuthorization } from "@zcode/shared";

const AUTH_HOSTS = new Set([
  "login.work.weixin.qq.com",
  "open.work.weixin.qq.com",
  "open.weixin.qq.com",
  "work.weixin.qq.com",
]);
/** 导航路由只识别协议/精确域名/回调地址，不包含登录业务状态。 */
export function classifyEnterpriseLoginNavigation(
  value: string,
  request: EnterpriseLoginAuthorization,
): "callback" | "authorization" | "blocked" {
  try {
    const url = new URL(value);
    const callback = new URL(request.callbackUrl);
    if (url.protocol !== "https:" || url.username || url.password) return "blocked";
    if (url.origin === callback.origin && url.pathname === callback.pathname) return "callback";
    return AUTH_HOSTS.has(url.hostname) && (!url.port || url.port === "443")
      ? "authorization"
      : "blocked";
  } catch {
    return "blocked";
  }
}
