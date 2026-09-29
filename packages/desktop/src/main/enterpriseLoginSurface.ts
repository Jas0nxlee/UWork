import type { EnterpriseLoginRequest, EnterpriseLoginSurface } from "@zcode/shared";

/** 新旧登录入口的回调域规则并不等价；展示改造不能改变已验证成功的授权 URL。 */
export function createEnterpriseEmbedUrl(request: EnterpriseLoginRequest): string {
  return request.authorizationUrl;
}

/** 只适配装饰和排版；确认、过期、刷新等授权状态保持可见，二维码留白保证对比度。 */
export function createEnterpriseEmbedCss(appearance: EnterpriseLoginSurface["appearance"]): string {
  // 真实新版独立页使用 wwLogin_*，其 120px 顶部留白与 480px 面板会裁切二维码；
  // 按实际 DOM 适配槽位，保留扫码状态和刷新操作，不能只覆盖旧版 loginPanel/impowerBox。
  return `
html, body { margin:0!important; padding:0!important; background:${appearance.backgroundColor}!important; color:${appearance.foregroundColor}!important; font-family:${appearance.fontFamily}!important; font-size:${appearance.fontSize}px!important; }
html,body { width:100%!important; height:100%!important; min-width:0!important; min-height:0!important; overflow:hidden!important; }
.wwLogin_standalone .wwLogin_frame { position:fixed!important; inset:0!important; display:flex!important; align-items:center!important; justify-content:center!important; width:100%!important; height:100%!important; min-width:0!important; padding:0!important; margin:0!important; box-sizing:border-box!important; }
.wwLogin_panel,.wwLogin_content,.wwLogin_content.wwLogin_err { width:100%!important; height:auto!important; min-width:0!important; min-height:0!important; margin:0!important; padding:0!important; border:0!important; box-shadow:none!important; background:transparent!important; color:inherit!important; box-sizing:border-box!important; }
.wwLogin_qrcode { display:flex!important; flex-direction:column!important; align-items:center!important; width:100%!important; margin:0!important; padding:0!important; }
.wwLogin_qrcode .wwLogin_panel_header { width:100%!important; padding:0 0 8px!important; border:0!important; }
.wwLogin_qrcode .wwLogin_panel_header:not(:has(.wwLogin_panel_header_operate)),.wwLogin_qrcode .wwLogin_panel_header_title,.wwLogin_qrcode_head,.wwLogin_frame_footer { display:none!important; }
.wwLogin_qrcode_content { width:100%!important; margin:0!important; padding:0!important; }
.wwLogin_qrcode_box { width:min(224px,calc(100vw - 24px),calc(100vh - 80px))!important; max-width:100%!important; padding:8px!important; border:0!important; border-radius:8px!important; background:#fff!important; box-sizing:border-box!important; }
.wwLogin_qrcode_img { width:100%!important; height:auto!important; aspect-ratio:1!important; object-fit:contain!important; margin:0!important; }
.wwLogin_qrcode_desc,.wwLogin_qrcode_notice { width:100%!important; margin:12px 0 0!important; color:inherit!important; font-family:inherit!important; font-size:inherit!important; line-height:1.4!important; text-align:center!important; }
.wwLogin_result { margin:0!important; padding:0 12px!important; }
.wwLogin_result .title,.wwLogin_result .desc { color:inherit!important; font-family:inherit!important; font-size:inherit!important; }
iframe[src^="https://open.work.weixin.qq.com/"],iframe[src^="https://login.work.weixin.qq.com/"] { position:fixed!important; inset:0!important; width:100%!important; height:100%!important; border:0!important; margin:0!important; padding:0!important; background:${appearance.backgroundColor}!important; }
.loginPanel,.impowerBox { width:100%!important; max-width:none!important; min-width:0!important; min-height:0!important; margin:0!important; padding:0!important; border:0!important; box-shadow:none!important; background:transparent!important; color:inherit!important; text-align:center!important; }
.impowerBox .title,.loginPanel .title { display:none!important; }
.wrp_code { margin:0!important; padding:0!important; width:100%!important; text-align:center!important; }
.impowerBox .qrcode,.loginPanel .qrcode,img.qrcode { width:min(224px,calc(100vw - 24px))!important; height:auto!important; margin:0 auto!important; padding:8px!important; border:0!important; border-radius:8px!important; background:#fff!important; box-sizing:border-box!important; }
.impowerBox .info,.impowerBox .status,.loginPanel .info { width:100%!important; color:inherit!important; background:transparent!important; font-family:inherit!important; font-size:inherit!important; box-shadow:none!important; }
`;
}

/** 仅设置自己的固定 style 节点；不读取表单、二维码、Cookie 或网页资料，不向 frame 暴露 IPC。 */
export function createEnterpriseFrameStyleScript(css: string): string {
  return `(() => { const id = 'uwork-enterprise-presentation'; let style = document.getElementById(id); if (style && style.tagName !== 'STYLE') return; if (!style) { style = document.createElement('style'); style.id = id; (document.head || document.documentElement).appendChild(style); } style.textContent = ${JSON.stringify(css)}; })()`;
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
