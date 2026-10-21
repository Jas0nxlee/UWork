import assert from "node:assert/strict";
import test from "node:test";
import type { EnterpriseIdentitySession, UcasGatewayState, UcasGatewayView } from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { createLocalIdentitySessionStore } from "../src/enterprise-identity/identitySessionStore.js";
import { createUcasGatewayService } from "../src/ucas-gateway/ucasGatewayService.js";
import type { UcasGatewayProvisioningTarget } from "../src/ucas-gateway/contract.js";
import type { UcasGatewayStore } from "../src/ucas-gateway/ucasGatewayStore.js";

const USER_A: EnterpriseIdentitySession = {
  profile: { id: "user-a", tenantId: "org-a", provider: "wecom", displayName: "用户 A" },
  token: "fixture-session-a",
  expiresAt: 4_000_000_000_000,
};
const USER_B: EnterpriseIdentitySession = {
  profile: { id: "user-b", tenantId: "org-b", provider: "wecom", displayName: "用户 B" },
  token: "fixture-session-b",
  expiresAt: 4_000_000_000_000,
};
const PROFILE_PATH = "/api/auth/refresh";
const USAGE_PATH = "/api/usage/stats";
const MODELS_PATH = "/api/usage/models";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function usage(period: string) {
  return {
    period,
    metric: "requests",
    from: "2026-10-01T00:00:00.000Z",
    until: "2026-10-04T00:00:00.000Z",
    summary: {
      requestCount: 1,
      successCount: 1,
      successRate: 100,
      cost: 1,
      averageCost: 1,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    trend: [],
    models: [],
  };
}

async function setup(
  overrides: {
    beforeHydrate?: () => Promise<void>;
    resolveApiBaseUrl?: () => Promise<string | undefined>;
  } = {},
) {
  const secrets = new Map<string, string>();
  const credentials: ICredentialService = {
    load: async (key) => secrets.get(key) ?? null,
    async save(key, value) {
      secrets.set(key, value);
    },
    async delete(key) {
      secrets.delete(key);
    },
  };
  const identitySessionStore = createLocalIdentitySessionStore(credentials);
  await identitySessionStore.write(USER_A, undefined, () => true);
  let persisted: UcasGatewayState | null = null;
  const writes: UcasGatewayState[] = [];
  const store: UcasGatewayStore = {
    async read() {
      await overrides.beforeHydrate?.();
      return persisted;
    },
    async write(next) {
      persisted = next;
      if (next) writes.push(next);
    },
  };
  const applied: Parameters<UcasGatewayProvisioningTarget["apply"]>[0][] = [];
  const provisioning: UcasGatewayProvisioningTarget = {
    async apply(input) {
      applied.push(input);
      return {
        apiKeyApplied: Boolean(input.apiKey),
        hasApiKey: true,
        modelsAdded: input.modelIds?.length ?? 0,
        modelsSkipped: 0,
      };
    },
    async listModels() {
      return [];
    },
  };
  const gates = new Map<
    string,
    {
      entered: ReturnType<typeof deferred<void>>;
      release: ReturnType<typeof deferred<void>>;
      failure?: Error;
    }
  >();
  const block = (path: string, failure?: Error) => {
    const gate = { entered: deferred<void>(), release: deferred<void>(), failure };
    gates.set(path, gate);
    return gate;
  };
  const networkRequests: { path: string; account: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const account =
      new Headers(init?.headers).get("authorization") === `Bearer ${USER_B.token}` ? "b" : "a";
    networkRequests.push({ path: url.pathname, account });
    const gate = gates.get(url.pathname);
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
      if (gate.failure) throw gate.failure;
    }
    switch (url.pathname) {
      case PROFILE_PATH:
        return json({
          token: `fixture-refreshed-${account}`,
          user: {
            id: `user-${account}`,
            org_id: `org-${account}`,
            role: "user",
            name: `用户 ${account}`,
          },
        });
      case "/api/keys":
        return json({
          keys: [
            {
              id: `key-${account}`,
              alias: "UWork",
              masked_key: `fixture…${account}`,
              status: "active",
            },
          ],
        });
      case "/api/keys/key-a/reveal":
      case "/api/keys/key-b/reveal":
        return json({ key: `fixture-gateway-key-${account}` });
      case "/api/auth/orgs":
        return json({
          orgs: [{ id: `org-${account}`, name: `组织 ${account}`, slug: `org-${account}` }],
          llm_base_url: `https://gateway-${account}.example.com/v1`,
        });
      case MODELS_PATH:
        return json({
          models: [`fixture-model-${account}`],
          unrestricted: false,
          hasSubscription: true,
        });
      case "/api/usage":
        return json({ subscriptions: [] });
      case USAGE_PATH:
        return json(usage(url.searchParams.get("period") ?? "month"));
      default:
        throw new Error(`Unexpected fixture request: ${url.pathname}`);
    }
  };
  const service = createUcasGatewayService({
    store,
    identitySessionStore,
    resolveApiBaseUrl: overrides.resolveApiBaseUrl ?? (async () => "https://identity.example.com"),
    provisioning,
    fetchImpl,
  });
  const events: UcasGatewayView[] = [];
  const subscription = service.onDidChange((view) => events.push(view));
  return {
    service,
    identitySessionStore,
    applied,
    writes,
    events,
    networkRequests,
    block,
    dispose() {
      for (const gate of gates.values()) gate.release.resolve();
      subscription.dispose();
      service.dispose();
    },
  };
}

for (const boundary of ["api-config", "hydrate"] as const) {
  test(
    `replace-key intent cannot rebind identities while awaiting ${boundary}`,
    { timeout: 5_000 },
    async () => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const fixture = await setup(
        boundary === "hydrate"
          ? { beforeHydrate: pause }
          : {
              resolveApiBaseUrl: async () => {
                await pause();
                return "https://identity.example.com";
              },
            },
      );
      try {
        const pending = fixture.service.replaceApiKey();
        await entered.promise;
        await fixture.identitySessionStore.write(USER_B, undefined, () => true);
        release.resolve();
        const result = await pending;
        assert.equal(result.committed, false);
        assert.deepEqual(fixture.applied, []);
        assert.deepEqual(fixture.writes, []);
        assert.deepEqual(fixture.networkRequests, []);
      } finally {
        release.resolve();
        fixture.dispose();
      }
    },
  );
}

test(
  "queued capture rejection is handled before its sync admission",
  { timeout: 5_000 },
  async () => {
    const fixture = await setup();
    const gate = fixture.block(PROFILE_PATH);
    try {
      const first = fixture.service.sync("login");
      await gate.entered.promise;
      const read = fixture.identitySessionStore.read;
      let failNext = true;
      fixture.identitySessionStore.read = async () => {
        if (failNext) {
          failNext = false;
          throw new Error("fixture identity read failure");
        }
        return read();
      };
      const second = fixture.service.replaceApiKey();
      const rejected = assert.rejects(second, /fixture identity read failure/);
      // 一轮真实事件循环检测未处理拒绝；不以 sleep 猜测网络或 admission 顺序。
      await new Promise<void>((resolve) => setImmediate(resolve));
      gate.release.resolve();
      assert.equal((await first).committed, true);
      await rejected;
    } finally {
      gate.release.resolve();
      fixture.dispose();
    }
  },
);

for (const scenario of ["logout", "switch", "same-user-relogin"] as const) {
  test(
    `late profile sync cannot commit after identity ${scenario}`,
    { timeout: 5_000 },
    async () => {
      const fixture = await setup();
      const gate = fixture.block(PROFILE_PATH);
      try {
        const pending = fixture.service.sync("login");
        await gate.entered.promise;
        const before = await fixture.identitySessionStore.read();
        if (scenario === "switch") {
          await fixture.identitySessionStore.write(USER_B, before.revision, () => true);
        } else {
          await fixture.identitySessionStore.write(null, before.revision, () => true);
          if (scenario === "same-user-relogin") {
            // principal 与 token 完全相同也必须由 revision 区分新的登录周期。
            await fixture.identitySessionStore.write(USER_A, undefined, () => true);
          }
        }
        await fixture.service.getView();
        const eventCount = fixture.events.length;
        gate.release.resolve();
        const result = await pending;
        assert.equal(result.committed, false);
        assert.deepEqual(fixture.applied, []);
        assert.deepEqual(fixture.writes, []);
        assert.equal(
          fixture.events.slice(eventCount).some((view) => view.status === "ready"),
          false,
        );
      } finally {
        gate.release.resolve();
        fixture.dispose();
      }
    },
  );
}

for (const scenario of ["principal-change", "token-renewal", "expiry"] as const) {
  test(
    `same-epoch ${scenario} preserves only a valid principal commit`,
    { timeout: 5_000 },
    async () => {
      const fixture = await setup();
      const gate = fixture.block(PROFILE_PATH);
      try {
        const pending = fixture.service.sync("login");
        await gate.entered.promise;
        const before = await fixture.identitySessionStore.read();
        const next = {
          "principal-change": USER_B,
          "token-renewal": { ...USER_A, token: "fixture-renewed-session-a" },
          expiry: { ...USER_A, expiresAt: Date.now() - 1 },
        }[scenario];
        const renewed = await fixture.identitySessionStore.renew(next, before, () => true);
        assert.equal(renewed.record.revision, before.revision);
        gate.release.resolve();
        const result = await pending;
        const committed = scenario === "token-renewal";
        assert.equal(result.committed, committed);
        assert.equal(fixture.applied.length, committed ? 1 : 0);
        assert.equal(fixture.writes.length, committed ? 1 : 0);
        if (scenario === "expiry") assert.equal(result.view.status, "signed-out");
      } finally {
        gate.release.resolve();
        fixture.dispose();
      }
    },
  );
}

for (const kind of ["usage", "models"] as const) {
  test(`late ${kind} cannot repopulate the signed-out view`, { timeout: 5_000 }, async () => {
    const fixture = await setup();
    try {
      assert.equal((await fixture.service.sync("login")).committed, true);
      const gate = fixture.block(kind === "usage" ? USAGE_PATH : MODELS_PATH);
      const pending =
        kind === "usage"
          ? fixture.service.refreshUsage({ period: "7d", metric: "requests" })
          : fixture.service.refreshModels();
      await gate.entered.promise;
      await fixture.identitySessionStore.write(null, undefined, () => true);
      assert.equal((await fixture.service.getView()).status, "signed-out");
      const eventCount = fixture.events.length;
      gate.release.resolve();
      const result = await pending;
      assert.equal(result.status, "signed-out");
      assert.equal(result[kind], null);
      assert.equal(
        fixture.events.slice(eventCount).some((view) => view[kind] !== null),
        false,
      );
    } finally {
      fixture.dispose();
    }
  });
}

test(
  "account switch prevents applyModels from applying the previous account projection",
  { timeout: 5_000 },
  async () => {
    const fixture = await setup();
    try {
      assert.equal((await fixture.service.sync("login")).committed, true);
      const priorCalls = fixture.applied.length;
      await fixture.identitySessionStore.write(USER_B, undefined, () => true);
      await fixture.service.applyModels();
      for (const input of fixture.applied.slice(priorCalls)) {
        assert.equal(input.baseUrl, "https://gateway-b.example.com/v1");
        assert.deepEqual(input.modelIds, ["fixture-model-b"]);
      }
    } finally {
      fixture.dispose();
    }
  },
);

test("late network error cannot overwrite the signed-out view", { timeout: 5_000 }, async () => {
  const fixture = await setup();
  const gate = fixture.block(PROFILE_PATH, new TypeError("fixture network failure"));
  try {
    const pending = fixture.service.sync("login");
    await gate.entered.promise;
    await fixture.identitySessionStore.write(null, undefined, () => true);
    await fixture.service.getView();
    const eventCount = fixture.events.length;
    gate.release.resolve();
    const result = await pending;
    assert.equal(result.committed, false);
    assert.equal(result.view.status, "signed-out");
    assert.equal(result.view.error, null);
    assert.equal(
      fixture.events.slice(eventCount).some((view) => view.error !== null),
      false,
    );
  } finally {
    gate.release.resolve();
    fixture.dispose();
  }
});
