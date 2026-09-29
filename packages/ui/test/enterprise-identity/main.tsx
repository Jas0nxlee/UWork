// 仅测试页面：不进入应用入口，不提供生产环境的虚假登录能力。
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import type { EnterpriseIdentityView, IPlatformService } from "@zcode/shared";
import type { IBroadcastService, IEnterpriseIdentityService } from "@zcode/services";
import { EnterpriseIdentityProvider } from "@/hooks/useEnterpriseIdentity.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceModeHeader } from "@/WorkspaceModeHeader.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const configured = params.has("configured");
const readOnly = params.has("readonly");
const changed = new Emitter<EnterpriseIdentityView>();
let view: EnterpriseIdentityView = {
  revision: 0,
  configured,
  status: "signed-out",
  profile: null,
  pending: null,
  error: configured ? null : "unconfigured",
};
const emit = (next: EnterpriseIdentityView) => {
  view = next;
  changed.fire(view);
};
const service: IEnterpriseIdentityService = {
  onDidChange: changed.event,
  getView: async () => view,
  restoreSession: async () => view,
  beginLogin: async () => {
    emit({
      revision: view.revision + 1,
      configured,
      status: "waiting",
      profile: null,
      pending: { id: "fixture", expiresAt: Date.now() + 60000 },
      error: null,
    });
    return {
      id: "fixture",
      authorizationUrl: "https://example.com/fixture-login",
      expiresAt: Date.now() + 60000,
    };
  },
  pollLogin: async () => {
    emit({
      revision: view.revision + 1,
      configured,
      status: "authenticated",
      profile: {
        id: "fixture-user",
        tenantId: "fixture-corp",
        provider: "wecom",
        displayName: params.has("longname") ? "测试长姓名用于验证侧栏截断及窄屏布局" : "测试用户",
      },
      pending: null,
      error: null,
    });
    return view;
  },
  cancelLogin: async () => {
    emit({
      revision: view.revision + 1,
      configured,
      status: "signed-out",
      profile: null,
      pending: null,
      error: null,
    });
  },
  logout: async () => {
    emit({
      revision: view.revision + 1,
      configured,
      status: "signed-out",
      profile: null,
      pending: null,
      error: null,
    });
  },
};
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as IBroadcastService;
const platform = { openExternal: () => {} } as unknown as IPlatformService;
localStorage.setItem("zcode-theme", params.has("dark") ? "zai-dark" : "zai-light");
localStorage.setItem("zcode-locale-preference", params.has("en") ? "en-US" : "zh-CN");
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider>
    <PlatformProvider platform={platform}>
      <StoreProvider broadcastService={broadcast}>
        <EnterpriseIdentityProvider
          service={service}
          showOnStartup={!readOnly}
          allowLogin={!readOnly}
        >
          <div className="flex h-dvh bg-background text-foreground">
            <aside className="w-64 max-w-full shrink-0 border-r border-border bg-sidebar p-3">
              <WorkspaceModeHeader />
            </aside>
            <main className="min-w-0 p-3">
              <label htmlFor="draft">本地草稿</label>
              <textarea id="draft" data-testid="local-draft" className="w-full bg-input" />
            </main>
          </div>
        </EnterpriseIdentityProvider>
      </StoreProvider>
    </PlatformProvider>
  </ZCodeIntlProvider>,
);
