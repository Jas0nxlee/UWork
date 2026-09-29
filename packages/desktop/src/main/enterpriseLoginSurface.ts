import type { EnterpriseLoginRequest, EnterpriseLoginSurface } from "@zcode/shared";

/** 官方 WwLogin 1.2.7 的 sso iframe 路由；组织 state 与随机回调 nonce 不做转换。 */
export function createEnterpriseEmbedUrl(request: EnterpriseLoginRequest): string {
  const original = new URL(request.authorizationUrl);
  const url = new URL("https://open.work.weixin.qq.com/wwopen/sso/qrConnect");
  url.search = new URLSearchParams({
    appid: original.searchParams.get("appid")!,
    agentid: original.searchParams.get("agentid")!,
    redirect_uri: request.callbackUrl,
    state: request.expectedState ?? request.id,
    lang:
      request.surface.appearance.language ??
      (original.searchParams.get("lang") === "en" ? "en" : "zh"),
    version: "1.2.7",
    login_type: "jssdk",
    href: `data:text/css;base64,${Buffer.from(createEnterpriseEmbedCss(request.surface.appearance)).toString("base64")}`,
  }).toString();
  return url.href;
}

/** 只适配装饰和排版；确认、过期、刷新等授权状态保持可见，二维码留白保证对比度。 */
export function createEnterpriseEmbedCss(appearance: EnterpriseLoginSurface["appearance"]): string {
  return `
html, body { margin:0!important; padding:0!important; background:${appearance.backgroundColor}!important; color:${appearance.foregroundColor}!important; font-family:${appearance.fontFamily}!important; font-size:${appearance.fontSize}px!important; }
body { overflow:hidden!important; }
.loginPanel,.impowerBox { width:100%!important; max-width:none!important; margin:0!important; padding:0!important; border:0!important; box-shadow:none!important; background:transparent!important; color:inherit!important; }
.impowerBox .title,.loginPanel .title { display:none!important; }
.wrp_code { margin-top:0!important; }
.impowerBox .qrcode,.loginPanel .qrcode,img.qrcode { width:min(224px,calc(100vw - 24px))!important; height:auto!important; margin:0 auto!important; padding:8px!important; border:0!important; border-radius:8px!important; background:#fff!important; box-sizing:border-box!important; }
.impowerBox .info,.impowerBox .status,.loginPanel .info { width:100%!important; color:inherit!important; background:transparent!important; font-family:inherit!important; font-size:inherit!important; box-shadow:none!important; }
`;
}

export function fitEnterpriseSurfaceBounds(
  bounds: EnterpriseLoginSurface["bounds"],
  zoom: number,
  contentSize: [number, number],
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(contentSize[0], Math.max(0, Math.round(bounds.x * zoom)));
  const y = Math.min(contentSize[1], Math.max(0, Math.round(bounds.y * zoom)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width * zoom), contentSize[0] - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height * zoom), contentSize[1] - y)),
  };
}
