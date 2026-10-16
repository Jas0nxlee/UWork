import { Emitter } from "@zcode/rpc";
import {
  ucasGatewayModelsSchema,
  ucasGatewaySyncResultSchema,
  ucasGatewayViewSchema,
  type UcasGatewayError,
  type UcasGatewaySyncResult,
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
import { readUcasGatewayProvisioningData } from "./ucasGatewayProvisioningData.js";
import {
  matchesSessionRecord,
  type IdentitySessionRecord,
  type IdentitySessionStore,
} from "../enterprise-identity/identitySessionStore.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

export interface UcasGatewayServiceOptions {
  readonly store: UcasGatewayStore;
  readonly identitySessionStore: Pick<IdentitySessionStore, "read" | "withCurrentSession">;
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
  let hydration: Promise<void> | undefined;
  let persisted: Awaited<ReturnType<UcasGatewayStore["read"]>> = null;
  let viewIdentity: IdentitySessionRecord | null = null;
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
  const hydrate = (): Promise<void> => {
    hydration ??= options.store.read().then(
      (state) => {
        persisted = state;
      },
      () => log.warn(undefined, "UCAS gateway state was not readable; continuing without it"),
    );
    return hydration;
  };
  const withIdentity = <T>(
    record: IdentitySessionRecord,
    operation: (current: IdentitySessionRecord) => Promise<T>,
    allowInactive = false,
  ) =>
    options.identitySessionStore.withCurrentSession(record, async (current) => {
      // 读取用锁内最新会话；同代际续期有效，但到期结果不能再提交本机副作用。
      if (disposed || (!allowInactive && (!current.session || current.session.expiresAt <= now())))
        return undefined;
      return operation(current);
    });
  type Scope = { record: IdentitySessionRecord; client: UcasGatewayClient | null };
  const captureScope = async (retryRead = false): Promise<Scope | null> => {
    // 写入意图先向身份 owner admission；不能等待 hydration 后才转而捕获另一个账号。
    let [record] = await Promise.all([options.identitySessionStore.read(), hydrate()]);
    while (!disposed) {
      const apiBaseUrl = record.session ? await options.resolveApiBaseUrl() : undefined;
      const scope = await withIdentity(
        record,
        async (current) => {
          const session = current.session;
          const active = session !== null && session.expiresAt > now();
          // 视图是身份代际的派生结果，切换账号时不能把旧账号模型/用量继续用于新账号。
          if (
            !viewIdentity ||
            !matchesSessionRecord(viewIdentity, current) ||
            (!active && view.status !== "signed-out") ||
            (active && view.status === "signed-out")
          ) {
            viewIdentity = current;
            const ownState =
              active &&
              persisted?.userId === session.profile.id &&
              persisted.orgId === session.profile.tenantId
                ? persisted
                : null;
            publish({
              ...view,
              status: active ? "idle" : "signed-out",
              configured: Boolean(apiBaseUrl),
              user: null,
              endpoint: view.endpoint ?? persisted?.endpoint ?? null,
              key: ownState?.key ?? null,
              subscriptions: [],
              usage: null,
              models: null,
              lastSyncedAt: ownState?.lastSyncedAt ?? null,
              error: null,
            });
          }
          return {
            record: current,
            client:
              active && apiBaseUrl
                ? createUcasGatewayClient({
                    apiBaseUrl,
                    token: session.token,
                    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                  })
                : null,
          };
        },
        true,
      );
      if (scope) return scope;
      // 只有纯视图读取可追上新身份；旧账号的写入意图失效即拒绝，绝不重绑。
      if (!retryRead) return null;
      record = await options.identitySessionStore.read();
    }
    return null;
  };
  const readView = async (): Promise<UcasGatewayView> => {
    await captureScope(true);
    return structuredClone(view);
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
  const uncommitted = async (): Promise<UcasGatewaySyncResult> => ({
    view: await readView(),
    committed: false,
    apiKeyApplied: false,
    apiKeyReused: false,
    providerHasApiKey: false,
    modelsAdded: 0,
    modelsSkipped: 0,
  });
  const runSync = async (reason: string, scope: Scope | null): Promise<UcasGatewaySyncResult> => {
    if (!scope) return uncommitted();
    const { record, client } = scope;
    if (!client) {
      if (record.session && record.session.expiresAt > now())
        await withIdentity(record, async () => {
          publish({ ...view, status: "idle", configured: false, error: "unconfigured" });
        });
      return uncommitted();
    }
    if (
      !(await withIdentity(record, async () => {
        publish({ ...view, status: "syncing", configured: true, error: null });
        return true;
      }))
    )
      return uncommitted();
    try {
      const user = await client.readProfile();
      if (user.id !== record.session!.profile.id || user.orgId !== record.session!.profile.tenantId)
        throw new UcasGatewayRequestError("unauthorized");
      const { keyInfo, endpoint, plan, subscriptions, usage } =
        await readUcasGatewayProvisioningData(client, {
          period: view.usage?.period ?? "month",
          metric: view.usage?.metric ?? "requests",
        });
      // 网络不占身份锁；退出/切换与本机写入在同一 Store 事务内按会话代际线性化。
      const result = await withIdentity(record, async () => {
        const applied = await options.provisioning.apply({
          baseUrl: endpoint.baseUrl,
          apiKey: keyInfo.apiKey,
          ...(reason === "replace-key" ? { replaceApiKey: true } : {}),
          modelIds: plan.ids,
        });
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
      });
      return result ?? uncommitted();
    } catch (error) {
      await withIdentity(record, async () => {
        publish({ ...view, status: "error", configured: true, error: errorCode(error) });
      });
      return uncommitted();
    }
  };
  const serializeSync = (
    reason: string,
    captured = captureScope(),
  ): Promise<UcasGatewaySyncResult> => {
    const previous = syncTask ?? Promise.resolve();
    // 排队意图绑定接收时的身份，不能在 A 的 replace-key 等待期间改用 B 的身份执行。
    // 捕获在排队期间也可能失败；立即接住拒绝，再在原队列位置传播，避免未处理拒绝终止 Host。
    const prepared = captured.then(
      (scope) => ({ ok: true as const, scope }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const result = await prepared;
        if (!result.ok) throw result.error;
        return runSync(reason, result.scope);
      });
    syncTask = task;
    const cleanup = () => {
      if (syncTask === task) syncTask = null;
    };
    void task.then(cleanup, cleanup);
    return task;
  };
  const withSession = async (
    operation: (client: UcasGatewayClient) => Promise<Partial<Omit<UcasGatewayView, "revision">>>,
    isCurrent: () => boolean = () => true,
  ): Promise<UcasGatewayView> => {
    const scope = await captureScope();
    if (!scope?.client) return readView();
    try {
      const patch = await operation(scope.client);
      await withIdentity(scope.record, async () => {
        if (isCurrent()) publish({ ...view, ...patch, error: null });
      });
    } catch (error) {
      // 错误也属于原请求的身份和周期，不能覆盖退出/切换后的视图。
      await withIdentity(scope.record, async () => {
        if (isCurrent()) publish({ ...view, error: errorCode(error) });
      });
    }
    return readView();
  };

  return {
    onDidChange: changed.event,
    getView: readView,
    sync: serializeSync,
    refreshUsage(request: UcasGatewayUsageRequest) {
      const serial = ++usageSerial;
      return withSession(
        async (client) => ({ usage: await client.readUsage(request) }),
        () => serial === usageSerial,
      );
    },
    refreshModels() {
      return withSession(async (client) => {
        const plan = await client.readPlanModels();
        const local = new Set(await options.provisioning.listModels());
        const pending = plan.models.filter((modelId) => !local.has(modelId));
        return {
          models: ucasGatewayModelsSchema.parse({
            available: plan.models,
            unrestricted: plan.unrestricted,
            hasSubscription: plan.hasSubscription,
            appliedCount: plan.models.length - pending.length,
            pendingCount: pending.length,
          }),
        };
      });
    },
    async applyModels() {
      const scope = await captureScope();
      if (!scope?.client) return uncommitted();
      const endpoint = view.endpoint;
      const ids = view.models?.available ?? [];
      if (!endpoint || ids.length === 0) return serializeSync("models", Promise.resolve(scope));
      const result = await withIdentity(scope.record, async () => {
        const applied = await options.provisioning.apply({
          baseUrl: endpoint.baseUrl,
          modelIds: ids,
        });
        publish({
          ...view,
          models: view.models
            ? {
                ...view.models,
                appliedCount: ids.length,
                pendingCount: 0,
              }
            : null,
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
      });
      return result ?? uncommitted();
    },
    replaceApiKey: () => serializeSync("replace-key"),
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
