import assert from "node:assert/strict";
import test from "node:test";
import { discoverProviderModels } from "../src/model-provider/providerModelDiscovery.js";
const config = {
  api: { type: "openai-chat-completions" as const, baseUrl: "https://models.example" },
  access: { type: "api-key" as const, apiKey: "test-key" },
};

test("root URL uses /v1/models and deduplicates IDs with saved auth", async () => {
  const ids = await discoverProviderModels(config, {
    request: async (url, init) => {
      assert.equal(String(url), "https://models.example/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      assert.equal(init?.redirect, "error");
      return Response.json({
        data: [{ id: "model-a" }, { id: " model-b " }, { id: "model-a" }, { id: "" }],
      });
    },
  });
  assert.deepEqual(ids, ["model-a", "model-b"]);
});

test("Anthropic preserves prefix, authenticates and follows bounded cursor pages", async () => {
  let calls = 0;
  const ids = await discoverProviderModels(
    {
      ...config,
      api: { type: "anthropic-messages", baseUrl: "https://models.example/proxy/v1/messages" },
    },
    {
      request: async (url, init) => {
        const u = new URL(String(url));
        assert.equal(u.pathname, "/proxy/v1/models");
        assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
        assert.equal(new Headers(init?.headers).get("anthropic-version"), "2023-06-01");
        calls++;
        if (calls === 1)
          return Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" });
        assert.equal(u.searchParams.get("after_id"), "a");
        return Response.json({ data: [{ id: "b" }], has_more: false });
      },
    },
  );
  assert.deepEqual(ids, ["a", "b"]);
  assert.equal(calls, 2);
});

test("root fallback is same origin and only for missing endpoint", async () => {
  let calls = 0;
  const ids = await discoverProviderModels(config, {
    request: async (url) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 404 });
      assert.equal(String(url), "https://models.example/models");
      return Response.json({ data: [] });
    },
  });
  assert.deepEqual(ids, []);
  assert.equal(calls, 2);
});

test("auth failures are sanitized and never retried or imported", async () => {
  let calls = 0;
  await assert.rejects(
    discoverProviderModels(config, {
      request: async () => {
        calls++;
        return new Response("secret-test-key", { status: 401 });
      },
    }),
    (e) =>
      e instanceof Error && e.message.includes("401") && !e.message.includes("secret-test-key"),
  );
  assert.equal(calls, 1);
});

test("rejects malformed lists, repeated cursors and URL credentials", async () => {
  await assert.rejects(
    discoverProviderModels(config, { request: async () => Response.json({ error: "hidden" }) }),
  );
  await assert.rejects(
    discoverProviderModels(config, {
      request: async () => Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" }),
    }),
  );
  await assert.rejects(
    discoverProviderModels(
      { ...config, api: { ...config.api, baseUrl: "https://user:secret@models.example" } },
      {
        request: async () => {
          throw Error("must not request");
        },
      },
    ),
  );
});

async function runtimeFixture(
  discoverModels: (
    config: import("@zcode/provider").ProviderConfigObject,
  ) => Promise<readonly string[]>,
) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { createProviderRuntime } = await import("../src/model-provider/providerRuntime.js");
  const dir = await mkdtemp(join(tmpdir(), "uwork-discovery-"));
  const runtime = createProviderRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
    discoverModels,
  });
  await runtime.start();
  const created = await runtime.providerSettings.createPersonalProvider({
    providerName: "Example",
    initialConfig: config,
  });
  return {
    service: runtime.providerSettings,
    id: created.providerId,
    dispose: async () => {
      runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("atomic import appends models and preserves existing disabled settings and order", async () => {
  const f = await runtimeFixture(async () => ["existing", "new-a", "new-b"]);
  try {
    await f.service.addPersonalModel(
      f.id,
      "existing",
      { properties: { contextWindow: 12345 } },
      true,
    );
    await f.service.setPersonalModelEnabled(f.id, "existing", false);
    const before = (await f.service.getView()).providers[0]!.models[0];
    const result = await f.service.discoverModels(f.id);
    assert.equal(result.added, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(
      result.view.providers[0]!.models.map((m) => m.modelId),
      ["existing", "new-a", "new-b"],
    );
    assert.deepEqual(result.view.providers[0]!.models[0], before);
    assert.equal((await f.service.discoverModels(f.id)).added, 0);
  } finally {
    await f.dispose();
  }
});

test("in-flight requests coalesce and changed connections reject the entire result", async () => {
  let release!: (ids: readonly string[]) => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => (started = resolve));
  let requests = 0;
  const f = await runtimeFixture(async () => {
    requests++;
    started();
    return new Promise((resolve) => (release = resolve));
  });
  try {
    const first = f.service.discoverModels(f.id),
      second = f.service.discoverModels(f.id);
    await waiting;
    assert.equal(requests, 1);
    await f.service.savePersonalProviderOverlay(f.id, {
      api: { baseUrl: "https://changed.example/v1" },
    });
    release(["should-not-be-added"]);
    await assert.rejects(first, /配置已变化/);
    await assert.rejects(second, /配置已变化/);
    assert.deepEqual((await f.service.getView()).providers[0]!.models, []);
  } finally {
    await f.dispose();
  }
});

test("oversized bodies and unsupported URLs fail before any import", async () => {
  await assert.rejects(
    discoverProviderModels(config, {
      request: async () => new Response("{}", { headers: { "content-length": "5000000" } }),
    }),
    /大小限制/,
  );
  await assert.rejects(
    discoverProviderModels(
      { ...config, api: { ...config.api, baseUrl: "file:///tmp/models" } },
      {
        request: async () => {
          throw Error("must not request");
        },
      },
    ),
    /HTTP/,
  );
});
