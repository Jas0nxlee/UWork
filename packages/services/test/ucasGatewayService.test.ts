import assert from "node:assert/strict";
import test from "node:test";
import type { EnterpriseIdentitySession, UcasGatewayState } from "@zcode/shared";
import { createUcasGatewayService } from "../src/ucas-gateway/ucasGatewayService.js";
import type { UcasGatewayProvisioningTarget } from "../src/ucas-gateway/contract.js";
import type { UcasGatewayStore } from "../src/ucas-gateway/ucasGatewayStore.js";

const API_BASE = "https://auth.example.com";
const INTERNAL = "http://llm.internal.example:14000"; // 服务端仍会下发，但客户端只用 HTTPS 入口
const PUBLIC = "https://llm.example.com:15000";

const session: EnterpriseIdentitySession = {
  profile: { id: "user-1", tenantId: "org-1", provider: "wecom", displayName: "测试用户" },
  token: "fixture-jwt",
  expiresAt: 4_000_000_000_000,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const refreshBody = {
  token: "fixture-jwt-2",
  user: {
    id: "user-1",
    org_id: "org-1",
    role: "user",
    wecom_userid: "wecom-1",
    name: "测试用户",
    email: "user@example.com",
    avatar: null,
    department: "研发中心",
    position: "工程师",
    monthly_budget: 25,
  },
};

const usageBody = {
  subscriptions: [
    {
      plan_id: "plan-1",
      plan_title: "标准套餐",
      amount_total: 50,
      amount_used: 12.5,
      next_reset_time: 1_800_000_000,
      status: "active",
    },
  ],
};

const statsBody = {
  period: "month",
  metric: "requests",
  from: "2026-10-01T00:00:00.000Z",
  until: "2026-10-04T00:00:00.000Z",
  summary: {
    requestCount: 120,
    successCount: 118,
    successRate: 97.6,
    cost: 1.25,
    averageCost: 0.01,
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  trend: [{ date: "2026-10-01", requestCount: 120, cost: 1.25, tokens: 1500 }],
  models: [{ model: "ucas-glm", requestCount: 120, cost: 1.25, share: 1 }],
};

const planModelsBody = {
  models: ["ucas-glm", "ucas-kimi"],
  unrestricted: false,
  hasSubscription: true,
};

function createMemoryStore(): UcasGatewayStore & { current: UcasGatewayState | null } {
  const store = {
    current: null as UcasGatewayState | null,
    async read() {
      return store.current;
    },
    async write(state: UcasGatewayState | null) {
      store.current = state;
    },
  };
  return store;
}

interface ProvisioningCall {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly replaceApiKey?: boolean;
  readonly modelIds?: readonly string[];
}

function createProvisioning(options: { hasKey?: boolean; models?: readonly string[] } = {}) {
  const calls: ProvisioningCall[] = [];
  let hasKey = options.hasKey ?? false;
  const models = new Set(options.models ?? []);
  const target: UcasGatewayProvisioningTarget = {
    async apply(input) {
      calls.push(input);
      const apiKeyApplied = Boolean(input.apiKey) && (input.replaceApiKey === true || !hasKey);
      if (apiKeyApplied) hasKey = true;
      let modelsAdded = 0;
      for (const modelId of input.modelIds ?? []) {
        if (!models.has(modelId)) {
          models.add(modelId);
          modelsAdded += 1;
        }
      }
      return {
        apiKeyApplied,
        hasApiKey: hasKey,
        modelsAdded,
        modelsSkipped: (input.modelIds?.length ?? 0) - modelsAdded,
      };
    },
    async listModels() {
      return [...models];
    },
  };
  return { calls, target, hasKey: () => hasKey };
}

function setup(options: {
  readonly authenticated?: boolean;
  readonly keys?: unknown;
  readonly provisioning?: ReturnType<typeof createProvisioning>;
  readonly configured?: boolean;
}) {
  const calls: string[] = [];
  const store = createMemoryStore();
  const provisioning = options.provisioning ?? createProvisioning();
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.origin}${url.pathname}`);
    if (url.origin === INTERNAL) {
      // 只保留 HTTPS：客户端不应再访问内网明文入口，出现即视为失败。
      throw new TypeError("internal endpoint must not be contacted");
    }
    if (url.pathname === "/api/auth/refresh") return json(refreshBody);
    if (url.pathname === "/api/keys") return json(options.keys ?? { keys: [] });
    if (url.pathname === "/api/keys/key-1/reveal") return json({ key: "sk-existing" });
    if (url.pathname === "/api/keys/generate")
      return json(
        { id: "key-2", key: "sk-generated", masked_key: "sk-…ated", status: "active" },
        201,
      );
    if (url.pathname === "/api/auth/orgs")
      return json({
        orgs: [{ id: "org-1", name: "组织", slug: "org" }],
        llm_base_url: PUBLIC,
        llm_base_url_internal: INTERNAL,
      });
    if (url.pathname === "/api/usage/models") return json(planModelsBody);
    if (url.pathname === "/api/usage/stats") return json(statsBody);
    if (url.pathname === "/api/usage") return json(usageBody);
    return json({ error: "not found" }, 404);
  };
  const service = createUcasGatewayService({
    store,
    readIdentitySession: async () => (options.authenticated === false ? null : session),
    resolveApiBaseUrl: async () => (options.configured === false ? undefined : API_BASE),
    provisioning: provisioning.target,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
  return { service, store, provisioning, calls, fetchImpl };
}

test("signed-out sync does not touch the network", async () => {
  const { service, calls } = setup({ authenticated: false });
  const result = await service.sync("startup");
  assert.equal(result.committed, false);
  assert.equal(result.providerHasApiKey, false);
  assert.deepEqual(calls, []);
  assert.equal((await service.getView()).status, "signed-out");
});

test("sync reuses an existing gateway key and keeps the public HTTPS endpoint", async () => {
  const { service, store, provisioning } = setup({
    keys: { keys: [{ id: "key-1", alias: "UWork", masked_key: "sk-…ting", status: "active" }] },
  });
  const result = await service.sync("login");
  assert.equal(result.committed, true);
  assert.equal(result.apiKeyReused, true);
  assert.equal(result.apiKeyApplied, true);
  assert.equal(result.providerHasApiKey, true);
  assert.deepEqual(provisioning.calls, [
    {
      baseUrl: `${PUBLIC}/v1`,
      apiKey: "sk-existing",
      modelIds: ["ucas-glm", "ucas-kimi"],
    },
  ]);
  const view = await service.getView();
  assert.equal(view.status, "ready");
  assert.equal(view.endpoint?.source, "public");
  assert.equal(view.endpoint?.internalBaseUrl, null);
  assert.equal(view.endpoint?.baseUrl, `${PUBLIC}/v1`);
  assert.equal(view.user?.department, "研发中心");
  assert.equal(view.user?.monthlyBudgetUsd, 25);
  assert.equal(view.subscriptions[0]?.planTitle, "标准套餐");
  assert.equal(view.usage?.summary.requestCount, 120);
  // 服务端成功率为百分数 97.6，视图按 0-1 比例呈现。
  assert.equal(view.usage?.summary.successRate, 0.976);
  assert.equal(view.models?.available.length, 2);
  assert.equal(store.current?.endpoint.baseUrl, `${PUBLIC}/v1`);
  assert.equal(store.current?.userId, "user-1");
});

test("sync generates a gateway key when none exists and never touches the internal entry", async () => {
  const provisioning = createProvisioning({ models: ["ucas-glm"] });
  const { service, store } = setup({ provisioning });
  const result = await service.sync("login");
  assert.equal(result.apiKeyApplied, true);
  assert.equal(result.apiKeyReused, false);
  assert.equal(result.modelsAdded, 1);
  assert.equal(result.modelsSkipped, 1);
  assert.deepEqual(provisioning.calls[0], {
    baseUrl: `${PUBLIC}/v1`,
    apiKey: "sk-generated",
    modelIds: ["ucas-glm", "ucas-kimi"],
  });
  assert.equal((await service.getView()).endpoint?.source, "public");
  assert.equal(store.current?.key?.maskedKey, "sk-…ated");
});

test("unauthenticated gateway responses surface as an unauthorized view error", async () => {
  const store = createMemoryStore();
  let applied = false;
  const service = createUcasGatewayService({
    store,
    readIdentitySession: async () => session,
    resolveApiBaseUrl: async () => API_BASE,
    provisioning: {
      async apply() {
        applied = true;
        return { apiKeyApplied: false, hasApiKey: false, modelsAdded: 0, modelsSkipped: 0 };
      },
      async listModels() {
        return [];
      },
    },
    fetchImpl: async () => json({ error: "unauthorized" }, 401),
  });
  const result = await service.sync("manual");
  assert.equal(result.committed, false);
  assert.equal(applied, false);
  const view = await service.getView();
  assert.equal(view.status, "error");
  assert.equal(view.error, "unauthorized");
  assert.equal(store.current, null);
});

test("repeat model application is idempotent", async () => {
  const provisioning = createProvisioning({ hasKey: true, models: ["ucas-glm", "ucas-kimi"] });
  const { service } = setup({ provisioning });
  await service.sync("manual");
  await service.refreshModels();
  const result = await service.applyModels();
  assert.equal(result.modelsAdded, 0);
  assert.equal(result.modelsSkipped, 2);
  assert.equal((await service.getView()).models?.pendingCount, 0);
});

test("an unconfigured host reports unconfigured without network calls", async () => {
  const { service, calls } = setup({ configured: false });
  const result = await service.sync("startup");
  assert.equal(result.committed, false);
  assert.deepEqual(calls, []);
  const view = await service.getView();
  assert.equal(view.error, "unconfigured");
  assert.equal(view.configured, false);
});
