import { Emitter } from "@zcode/rpc";
import {
  ucasGatewayModelsSchema,
  ucasGatewaySyncResultSchema,
  ucasGatewayViewSchema,
  type EnterpriseIdentitySession,
  type UcasGatewayEndpoint,
  type UcasGatewayError,
  type UcasGatewaySyncResult,
  type UcasGatewaySubscription,
  type UcasGatewayUsageRequest,
  type UcasGatewayView,
} from "@zcode/shared";
import type { IUcasGatewayService, UcasGatewayProvisioningTarget } from "./contract.js";
import {
  UcasGatewayRequestError,
  createUcasGatewayClient,
  type UcasGatewayClient,
} from "./ucasGatewayClient.js";
import type { UcasGatewayStore } from "./ucasGatewayStore.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

/** 企业账号在本机没有 Key 时自动创建的网关 Key 别名（服务端上限 13 字符）。 */
const GATEWAY_KEY_ALIAS = "UWork";

export interface UcasGatewayServiceOptions {
  readonly store: UcasGatewayStore;
  readonly readIdentitySession: () => Promise<EnterpriseIdentitySession | null>;
  /** 企业认证服务根地址；同时承载网关 API。 */
  readonly resolveApiBaseUrl: () => Promise<string | undefined>;
  readonly provisioning: UcasGatewayProvisioningTarget;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onDiagnostic?: (event: { readonly code: string; readonly reason: string }) => void;
}

export function createUcasGatewayService(
  options: UcasGatewayServiceOptions,
): IUcasGatewayService & { dispose(): void; disposeAll(): void } {
  const log = createServiceLogger("ucas-gateway");
  const now = options.now ?? Date.now;
  const changed = new Emitter<UcasGatewayView>();
  let disposed = false;
  let hydrated = false;
  let syncTask: Promise<UcasGatewaySyncResult> | null = null;
  let usageSerial = 0;
  let view: UcasGatewayView = {
    revision: 0,
    status: "signed-out",
    configured: false,
    user: null,
    endpoint: null,
    key: null,
    subscriptions: [],
    usage: null,
    models: null,
    lastSyncedAt: null,
    error: null,
  };

  const publish = (next: Omit<UcasGatewayView, "revision">): void => {
    if (disposed) return;
    const parsed = ucasGatewayViewSchema.safeParse({ ...next, revision: view.revision + 1 });
    if (!parsed.success) {
      // 视图是不可信外部数据的投影；不合格的字段宁可丢弃也不能进入 Renderer。
      log.warn(undefined, "UCAS gateway view was rejected by its schema");
      return;
    }
    view = parsed.data;
    changed.fire(structuredClone(view));
  };
  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    hydrated = true;
    try {
      const state = await options.store.read();
      if (state) {
        publish({
          ...view,
          status: "idle",
          endpoint: state.endpoint,
          key: state.key,
          lastSyncedAt: state.lastSyncedAt,
        });
      }
    } catch {
      log.warn(undefined, "UCAS gateway state was not readable; continuing without it");
    }
  };
  const diagnostic = (code: UcasGatewayError, reason: string): UcasGatewayError => {
    options.onDiagnostic?.({ code, reason });
    log.warn(undefined, "UCAS gateway request failed", { code, reason });
    return code;
  };
  const errorCode = (error: unknown): UcasGatewayError => {
    if (error instanceof UcasGatewayRequestError) {
      if (error.kind === "unauthorized") return diagnostic("unauthorized", "unauthorized");
      if (error.kind === "network") return diagnostic("network", "network");
      return diagnostic("failed", `http-${error.status ?? 0}`);
    }
    return diagnostic("failed", "unexpected");
  };
  const signedOutResult = (): UcasGatewaySyncResult => ({
    view: structuredClone(view),
    committed: false,
    apiKeyApplied: false,
    apiKeyReused: false,
    providerHasApiKey: false,
    modelsAdded: 0,
    modelsSkipped: 0,
  });
  /**
   * 只使用公网 HTTPS 入口。服务端同时下发 `llm_base_url_internal`（明文 http、仅校园网可达），
   * 需要统一走 TLS 且不把内网地址带进客户端，因此既不探测也不写入 Provider 配置。
   */
  const resolveEndpoint = (endpoints: { publicBaseUrl: string }): UcasGatewayEndpoint => ({
    baseUrl: endpoints.publicBaseUrl,
    publicBaseUrl: endpoints.publicBaseUrl,
    internalBaseUrl: null,
    source: "public",
  });
  const ensureKey = async (
    client: UcasGatewayClient,
  ): Promise<{ key: UcasGatewayView["key"]; apiKey: string; reused: boolean }> => {
    const keys = await client.listKeys();
    const active = keys.find((item) => item.status === "active") ?? keys[0];
    if (active) {
      const apiKey = await client.revealKey(active.id);
      return { key: active, apiKey, reused: true };
    }
    const generated = await client.generateKey(GATEWAY_KEY_ALIAS);
    return { key: generated.key, apiKey: generated.apiKey, reused: false };
  };
  const readPlanModels = async (
    client: UcasGatewayClient,
    endpoint: UcasGatewayEndpoint,
    apiKey: string,
  ): Promise<{ ids: readonly string[]; unrestricted: boolean; hasSubscription: boolean }> => {
    const plan = await client.readPlanModels();
    if (plan.models.length > 0) {
      return {
        ids: plan.models,
        unrestricted: plan.unrestricted,
        hasSubscription: plan.hasSubscription,
      };
    }
    // 套餐不限模型时回退到协议级 `/models`；读取失败不阻断 Key 与端点配置。
    try {
      const ids = await client.listEndpointModels(endpoint.baseUrl, apiKey);
      return { ids, unrestricted: plan.unrestricted, hasSubscription: plan.hasSubscription };
    } catch {
      return { ids: [], unrestricted: plan.unrestricted, hasSubscription: plan.hasSubscription };
    }
  };
  const runSync = async (reason: string): Promise<UcasGatewaySyncResult> => {
    await hydrate();
    const session = await options.readIdentitySession();
    if (!session) {
      publish({ ...view, status: "signed-out", error: null });
      return signedOutResult();
    }
    const apiBaseUrl = await options.resolveApiBaseUrl();
    if (!apiBaseUrl) {
      publish({ ...view, status: "idle", configured: false, error: "unconfigured" });
      return signedOutResult();
    }
    publish({ ...view, status: "syncing", configured: true, error: null });
    const client = createUcasGatewayClient({
      apiBaseUrl,
      token: session.token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    try {
      const user = await client.readProfile();
      const keyInfo = await ensureKey(client);
      const endpoint = resolveEndpoint(await client.readGatewayEndpoints());
      const plan = await readPlanModels(client, endpoint, keyInfo.apiKey);
      const applied = await options.provisioning.apply({
        baseUrl: endpoint.baseUrl,
        apiKey: keyInfo.apiKey,
        ...(reason === "replace-key" ? { replaceApiKey: true } : {}),
        modelIds: plan.ids,
      });
      // 套餐读取失败不阻断已完成的关键配置：视图字段要求可变数组，显式拷贝一次。
      const subscriptions: UcasGatewaySubscription[] = [
        ...(await client.readSubscriptions().catch(() => [])),
      ];
      const usage = await client
        .readUsage({
          period: view.usage?.period ?? "month",
          metric: view.usage?.metric ?? "requests",
        })
        .catch(() => null);
      const lastSyncedAt = now();
      await options.store
        .write({
          version: 1,
          userId: user.id,
          orgId: user.orgId,
          endpoint,
          key: keyInfo.key,
          lastSyncedAt,
        })
        .catch(() => log.warn(undefined, "UCAS gateway state was not persisted"));
      publish({
        ...view,
        status: "ready",
        configured: true,
        user,
        endpoint,
        key: keyInfo.key,
        subscriptions,
        usage,
        models: ucasGatewayModelsSchema.parse({
          available: [...plan.ids],
          unrestricted: plan.unrestricted,
          hasSubscription: plan.hasSubscription,
          appliedCount: plan.ids.length,
          pendingCount: 0,
        }),
        lastSyncedAt,
        error: null,
      });
      log.info(undefined, "UCAS gateway provisioning synced", {
        reason,
        endpoint: endpoint.source,
        authMode: keyInfo.reused ? "reused" : "generated",
      });
      return ucasGatewaySyncResultSchema.parse({
        view: structuredClone(view),
        committed: true,
        apiKeyApplied: applied.apiKeyApplied,
        apiKeyReused: keyInfo.reused,
        providerHasApiKey: applied.hasApiKey,
        modelsAdded: applied.modelsAdded,
        modelsSkipped: applied.modelsSkipped,
      });
    } catch (error) {
      publish({ ...view, status: "error", configured: true, error: errorCode(error) });
      return signedOutResult();
    }
  };
  const serializeSync = (reason: string): Promise<UcasGatewaySyncResult> => {
    const previous = syncTask ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => (disposed ? signedOutResult() : runSync(reason)));
    syncTask = task;
    const cleanup = () => {
      if (syncTask === task) syncTask = null;
    };
    void task.then(cleanup, cleanup);
    return task;
  };
  const withSession = async (
    operation: (client: UcasGatewayClient) => Promise<void>,
    isCurrent: () => boolean = () => true,
  ): Promise<UcasGatewayView> => {
    await hydrate();
    const session = await options.readIdentitySession();
    const apiBaseUrl = session ? await options.resolveApiBaseUrl() : undefined;
    if (!session || !apiBaseUrl) return structuredClone(view);
    const client = createUcasGatewayClient({
      apiBaseUrl,
      token: session.token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    try {
      await operation(client);
      if (!isCurrent()) return structuredClone(view);
      if (view.error !== null) publish({ ...view, error: null });
    } catch (error) {
      // 过期请求的失败同样不能覆盖用户当前的选择（例如连点周期后旧请求超时）。
      if (isCurrent()) publish({ ...view, error: errorCode(error) });
    }
    return structuredClone(view);
  };

  return {
    onDidChange: changed.event,
    async getView() {
      await hydrate();
      const session = await options.readIdentitySession();
      if (!session && view.status !== "signed-out") {
        publish({
          ...view,
          status: "signed-out",
          user: null,
          key: null,
          subscriptions: [],
          usage: null,
          models: null,
          error: null,
        });
      } else if (session && view.status === "signed-out") {
        publish({
          ...view,
          status: "idle",
          configured: Boolean(await options.resolveApiBaseUrl()),
        });
      }
      return structuredClone(view);
    },
    sync(reason) {
      return serializeSync(reason);
    },
    refreshUsage(request: UcasGatewayUsageRequest) {
      // 服务端统计是慢聚合：连续切换周期/指标时，响应可能乱序返回。
      // 只接受最后一次请求的结果，避免旧周期数据把新选择覆盖回去（界面表现为来回闪动）。
      const serial = ++usageSerial;
      return withSession(
        async (client) => {
          const usage = await client.readUsage(request);
          if (serial !== usageSerial) return;
          publish({ ...view, status: view.status === "signed-out" ? "ready" : view.status, usage });
        },
        () => serial === usageSerial,
      );
    },
    async refreshModels() {
      return withSession(async (client) => {
        await hydrate();
        const endpoint = view.endpoint;
        if (!endpoint) return;
        const plan = await client.readPlanModels();
        const local = new Set(await options.provisioning.listModels());
        const pending = plan.models.filter((modelId) => !local.has(modelId));
        publish({
          ...view,
          models: ucasGatewayModelsSchema.parse({
            available: plan.models,
            unrestricted: plan.unrestricted,
            hasSubscription: plan.hasSubscription,
            appliedCount: plan.models.length - pending.length,
            pendingCount: pending.length,
          }),
        });
      });
    },
    async applyModels() {
      await hydrate();
      const endpoint = view.endpoint;
      const ids = view.models?.available ?? [];
      if (!endpoint || ids.length === 0) return serializeSync("models");
      const applied = await options.provisioning.apply({
        baseUrl: endpoint.baseUrl,
        modelIds: ids,
      });
      publish({
        ...view,
        models: view.models
          ? { ...view.models, appliedCount: ids.length, pendingCount: 0 }
          : view.models,
      });
      return ucasGatewaySyncResultSchema.parse({
        view: structuredClone(view),
        committed: true,
        apiKeyApplied: false,
        apiKeyReused: false,
        providerHasApiKey: applied.hasApiKey,
        modelsAdded: applied.modelsAdded,
        modelsSkipped: applied.modelsSkipped,
      });
    },
    replaceApiKey() {
      return serializeSync("replace-key");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      changed.dispose();
    },
    disposeAll() {
      disposed = true;
      changed.dispose();
    },
  };
}
