import { installOrganizationStartFixture } from "./organizationStartFixture.js";
// 仅测试页面：不进入应用入口，不提供生产环境的虚假登录能力。
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import {
  enterpriseLoginRequestSchema,
  enterpriseLoginSurfaceUpdateSchema,
  type EnterpriseIdentityView,
  type IPlatformService,
} from "@zcode/shared";
import type {
  IBroadcastService,
  IEnterpriseIdentityService,
  IProviderSettingsService,
  ProviderSettingsView,
} from "@zcode/services";
import { EnterpriseIdentityProvider } from "@/hooks/useEnterpriseIdentity.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceModeHeader } from "@/WorkspaceModeHeader.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const configured = params.has("configured");
const readOnly = params.has("readonly");
const native = params.has("native");
const nativeCallback = "https://auth.example.com/callback";
const nativeId = "fixture-native-state";
const changed = new Emitter<EnterpriseIdentityView>();
let restoreCancelled = false;
let view: EnterpriseIdentityView = {
  revision: 0,
  configured,
  organizations: [],
  selectedOrgId: null,
  status: "signed-out",
  profile: null,
  pending: null,
  error: configured ? null : "unconfigured",
};
const emit = (next: EnterpriseIdentityView) => {
  view = { ...view, ...next };
  changed.fire(view);
};
// 仅供隔离浏览器场景使用：模拟本机 UCAS 配置，持久化标记不包含输入的密钥。
const persistedFixtureKey = sessionStorage.getItem("uwork-identity-test-ucas-saved") === "1";
const initialFixtureKey =
  params.has("existing_key") || persistedFixtureKey ? "fixture-existing-key" : "";
const initialPersonalConfig = {
  group: "standard-personal" as const,
  access: { type: "api-key" as const, apiKey: initialFixtureKey },
  api: { headers: { "x-fixture": "preserve" } },
  personalModelIds: ["fixture-model"],
  modelOrder: ["fixture-model"],
};
let providerView: ProviderSettingsView = {
  revision: 1,
  providerTemplates: [],
  providerOrder: ["ucas"],
  providers: [
    {
      providerId: "ucas",
      providerName: "ucas",
      templateId: "ucas",
      enabled: true,
      executable: Boolean(initialFixtureKey),
      effectiveConfig: {
        ...initialPersonalConfig,
        api: {
          type: "openai-chat-completions",
          baseUrl: "https://fixture.example/v1",
          headers: { "x-fixture": "preserve" },
        },
      },
      personalConfig: initialPersonalConfig,
      issues: [],
      models: [],
    },
  ],
};
document.documentElement.dataset.ucasKeyStored = String(Boolean(initialFixtureKey));
let failNextSave = params.has("save_fail");
const providerSettingsService: Pick<
  IProviderSettingsService,
  "refresh" | "setUcasApiKeyIfMissing"
> = {
  refresh: async () => {
    const reads = Number(document.documentElement.dataset.ucasRefreshCount ?? 0) + 1;
    document.documentElement.dataset.ucasRefreshCount = String(reads);
    if (params.has("key_before_prompt") && reads === 1) {
      const current = providerView.providers.find((candidate) => candidate.providerId === "ucas");
      if (!current) throw new Error("Fixture UCAS provider is missing");
      providerView = {
        ...providerView,
        revision: providerView.revision + 1,
        providers: [
          {
            ...current,
            personalConfig: {
              ...current.personalConfig,
              access: { type: "api-key", apiKey: "fixture-other-window-key" },
            },
          },
        ],
      };
      document.documentElement.dataset.ucasKeyStored = "true";
    }
    return providerView;
  },
  setUcasApiKeyIfMissing: async (apiKey) => {
    document.documentElement.dataset.ucasAtomicSaveCalls = String(
      Number(document.documentElement.dataset.ucasAtomicSaveCalls ?? 0) + 1,
    );
    if (failNextSave) {
      failNextSave = false;
      document.documentElement.dataset.ucasSaveFailed = "true";
      throw new Error("Fixture save failure");
    }
    let current = providerView.providers.find((candidate) => candidate.providerId === "ucas");
    if (!current) throw new Error("Fixture UCAS provider is missing");
    // 模拟另一个窗口恰在 owner 锁内重读前提交密钥和其它配置。
    if (params.has("key_arrives")) {
      const concurrentConfig = {
        ...current.personalConfig,
        access: { type: "api-key" as const, apiKey: "fixture-other-window-key" },
        api: {
          ...current.personalConfig?.api,
          headers: { "x-fixture": "preserve", "x-concurrent": "latest" },
        },
        personalModelIds: ["fixture-model", "concurrent-model"],
        modelOrder: ["fixture-model", "concurrent-model"],
      };
      current = { ...current, personalConfig: concurrentConfig };
      providerView = {
        ...providerView,
        revision: providerView.revision + 1,
        providers: [current],
      };
    }
    const personalConfig = current.personalConfig;
    if (!personalConfig) throw new Error("Fixture UCAS personal config is missing");
    const existingKey =
      personalConfig.access?.type === "api-key" ? personalConfig.access.apiKey?.trim() : null;
    const savedPersonalConfig = existingKey
      ? personalConfig
      : {
          ...personalConfig,
          access: {
            ...personalConfig.access,
            type: "api-key" as const,
            apiKey: apiKey.trim(),
          },
        };
    providerView = {
      ...providerView,
      revision: providerView.revision + (existingKey ? 0 : 1),
      providers: [
        {
          ...current,
          personalConfig: savedPersonalConfig,
          effectiveConfig: {
            ...current.effectiveConfig,
            access: savedPersonalConfig.access,
          },
        },
      ],
    };
    const savedAccess = savedPersonalConfig.access;
    const stored = savedAccess?.type === "api-key" && Boolean(savedAccess.apiKey?.trim());
    document.documentElement.dataset.ucasKeyStored = String(stored);
    document.documentElement.dataset.ucasConfigPreserved = String(
      savedPersonalConfig.api?.headers?.["x-fixture"] === "preserve" &&
        savedPersonalConfig.personalModelIds?.[0] === "fixture-model" &&
        savedPersonalConfig.modelOrder?.[0] === "fixture-model" &&
        (!params.has("key_arrives") ||
          (savedPersonalConfig.api?.headers?.["x-concurrent"] === "latest" &&
            savedPersonalConfig.personalModelIds?.[1] === "concurrent-model" &&
            savedPersonalConfig.modelOrder?.[1] === "concurrent-model")),
    );
    document.documentElement.dataset.ucasOtherWriterPreserved = String(
      params.has("key_arrives") &&
        savedAccess?.type === "api-key" &&
        savedAccess.apiKey === "fixture-other-window-key",
    );
    if (stored) sessionStorage.setItem("uwork-identity-test-ucas-saved", "1");
    return providerView;
  },
};
const authenticateFixture = () => {
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
};
const service: IEnterpriseIdentityService = {
  onDidChange: changed.event,
  getView: async () => view,
  restoreSession: async () => {
    if (params.has("slowrestore")) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (restoreCancelled) return view;
      emit({
        revision: view.revision + 1,
        configured: true,
        status: "authenticated",
        profile: {
          id: "fixture-user",
          tenantId: "fixture-corp",
          provider: "wecom",
          displayName: "测试用户",
        },
        pending: null,
        error: null,
      });
    }
    return view;
  },
  beginLogin: async () => {
    emit({
      revision: view.revision + 1,
      configured,
      status: "waiting",
      profile: null,
      pending: {
        id: native ? nativeId : "fixture",
        expiresAt: Date.now() + 60000,
        ...(native ? { callbackUrl: nativeCallback } : {}),
      },
      error: null,
    });
    const attempt = {
      id: native ? nativeId : "fixture",
      authorizationUrl: native
        ? `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=wx-fixture&agentid=1000001&state=${nativeId}&redirect_uri=${encodeURIComponent(nativeCallback)}`
        : "https://example.com/fixture-login",
      expiresAt: Date.now() + 60000,
      ...(native ? { callbackUrl: nativeCallback } : {}),
    };
    if (params.has("fast_poll") && !native) {
      // 让 waiting 事件的轮询先于 beginLogin 的 continuation 完成。
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    document.documentElement.dataset.beginLoginReturned = "true";
    return attempt;
  },
  // 原生扫码由回调认领；轮询保持 waiting，避免夹具在扫码视图就绪前抢先认证。
  pollLogin: async () => (native ? view : authenticateFixture()),
  completeLogin: async (attemptId) => ({
    view: authenticateFixture(),
    committedAttemptId: params.has("stale_native") ? null : attemptId,
  }),
  cancelLogin: async (attemptId) => {
    if (!attemptId) {
      restoreCancelled = true;
      document.documentElement.dataset.cancelWithoutId = "true";
    }
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
if (params.has("multi_org")) {
  view = installOrganizationStartFixture({
    service,
    readView: () => view,
    emit,
    params,
    nativeCallback,
  });
}
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as unknown as IBroadcastService;
let cancelNative: (() => void) | null = null;
const platform = {
  openExternal: () => {
    document.documentElement.dataset.externalOpens = String(
      Number(document.documentElement.dataset.externalOpens ?? 0) + 1,
    );
  },
  openEnterpriseLogin: async (request: unknown) => {
    const parsedRequest = enterpriseLoginRequestSchema.parse(request);
    if (params.has("multi_org")) {
      document.documentElement.dataset.nativeRequests = JSON.stringify([
        ...JSON.parse(document.documentElement.dataset.nativeRequests ?? "[]"),
        parsedRequest,
      ]);
      return new Promise<string | null>((resolve) => {
        cancelNative = () => resolve(null);
      });
    }
    document.documentElement.dataset.nativeOpened = "true";
    if (params.has("native_fail")) throw new Error("Fixture native view unavailable");
    return params.has("cancel") || params.has("scan")
      ? new Promise<string | null>((resolve) => {
          cancelNative = () => resolve(null);
        })
      : `${nativeCallback}?code=fixture-code&state=${nativeId}`;
  },
  updateEnterpriseLogin: (update: unknown) => {
    const parsed = enterpriseLoginSurfaceUpdateSchema.parse(update);
    document.documentElement.dataset.nativeUpdates = String(
      Number(document.documentElement.dataset.nativeUpdates ?? 0) + 1,
    );
    document.documentElement.dataset.nativeSurface = JSON.stringify(parsed.surface);
  },
  cancelEnterpriseLogin: () => {
    cancelNative?.();
    cancelNative = null;
  },
} as unknown as IPlatformService;
localStorage.setItem("zcode-theme", params.has("dark") ? "zai-dark" : "zai-light");
localStorage.setItem("zcode-locale-preference", params.has("en") ? "en-US" : "zh-CN");
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider>
    <PlatformProvider platform={platform}>
      <StoreProvider broadcastService={broadcast}>
        <EnterpriseIdentityProvider
          service={service}
          providerSettingsService={providerSettingsService}
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
