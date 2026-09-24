import assert from "node:assert/strict";
import test from "node:test";
import { discoverProviderModels } from "../src/model-provider/providerModelDiscovery.js";
const config = {
  api: { type: "openai-chat-completions" as const, baseUrl: "https://models.example" },
  access: { type: "api-key" as const, apiKey: "test-key" },
};

function requireProvider(view: import("@zcode/services").ProviderSettingsView, providerId: string) {
  const provider = view.providers.find((candidate) => candidate.providerId === providerId);
  assert.ok(provider, `missing provider ${providerId}`);
  return provider;
}

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
    runtime,
    service: runtime.providerSettings,
    personalFilePath: join(dir, "personal.json"),
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
    const before = requireProvider(await f.service.getView(), f.id).models[0];
    const result = await f.service.discoverModels(f.id);
    assert.equal(result.added, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(
      requireProvider(result.view, f.id).models.map((m) => m.modelId),
      ["existing", "new-a", "new-b"],
    );
    assert.deepEqual(requireProvider(result.view, f.id).models[0], before);
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
    assert.deepEqual(requireProvider(await f.service.getView(), f.id).models, []);
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

test("discovered model edits accept current revisions and continue to reject stale drafts", async () => {
  const fixture = await runtimeFixture(async () => ["discovered-model"]);
  try {
    const imported = await fixture.service.discoverModels(fixture.id);
    const input = {
      providerId: fixture.id,
      originalModelId: "discovered-model",
      nextModelId: "discovered-model",
      personalConfig: { properties: { contextWindow: 1000000 } },
      useRecommendedConfig: true,
      basedOnRevision: imported.view.revision,
    };
    const saved = await fixture.service.savePersonalModelDraft(input);
    assert.equal(
      requireProvider(saved, fixture.id).models[0]!.effectiveConfig.properties?.contextWindow,
      1000000,
    );
    await assert.rejects(
      fixture.service.savePersonalModelDraft({
        ...input,
        personalConfig: { properties: { contextWindow: 512000 } },
      }),
      /revision conflict/,
    );
    assert.equal(
      requireProvider(await fixture.service.getView(), fixture.id).models[0]!.effectiveConfig
        .properties?.contextWindow,
      1000000,
    );
  } finally {
    await fixture.dispose();
  }
});

test("default UCAS provider is seeded and discovered models receive fixed metadata", async () => {
  const fixture = await runtimeFixture(async (providerConfig) => {
    assert.equal(providerConfig.api?.baseUrl, "https://lm.ucas.com.cn:15000/v1");
    assert.equal(providerConfig.api?.type, "openai-chat-completions");
    return ["ucas-new-model", "ucas-gpt-max"];
  });
  try {
    const initial = requireProvider(await fixture.service.getView(), "ucas");
    assert.equal(initial.effectiveConfig.api?.baseUrl, "https://lm.ucas.com.cn:15000/v1");
    assert.equal(initial.effectiveConfig.api?.type, "openai-chat-completions");
    assert.deepEqual(
      initial.models.map((model) => model.modelId),
      [
        "ucas-deepseek-flash",
        "ucas-gpt-max",
        "ucas-gpt-mini",
        "ucas-kimi",
        "ucas-glm",
        "ucas-gemini-flash",
      ],
    );
    for (const model of initial.models) {
      assert.equal(model.effectiveConfig.properties?.contextWindow, 1_000_000);
      assert.equal(model.effectiveConfig.properties?.inputFormat?.supportsText, true);
      assert.equal(model.effectiveConfig.properties?.inputFormat?.supportsImage, true);
      assert.deepEqual(model.effectiveConfig.optionSpecs?.reasoningLevel?.values, [
        "low",
        "high",
        "max",
      ]);
    }

    const imported = await fixture.service.discoverModels("ucas");
    const updated = requireProvider(imported.view, "ucas");
    assert.equal(imported.added, 1);
    assert.equal(imported.skipped, 1);
    const discovered = updated.models.find((model) => model.modelId === "ucas-new-model");
    assert.ok(discovered);
    assert.equal(discovered.effectiveConfig.properties?.contextWindow, 1_000_000);
    assert.equal(discovered.effectiveConfig.properties?.inputFormat?.supportsText, true);
    assert.equal(discovered.effectiveConfig.properties?.inputFormat?.supportsImage, true);
    assert.deepEqual(discovered.effectiveConfig.optionSpecs?.reasoningLevel?.values, [
      "low",
      "high",
      "max",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("legacy UCAS provider migrates to fixed connection and preserves its key, models, and order", async () => {
  const fixture = await runtimeFixture(async () => []);
  const {
    ApiKeyAccessConfig,
    ModelConfig,
    ModelPropertiesConfig,
    ProviderApiConfig,
    ProviderConfig: ProviderConfigValue,
    UCAS_DEFAULT_MODEL_IDS,
    UCAS_PROVIDER_ID,
    UCAS_PROVIDER_NAME,
    UCAS_PROVIDER_TEMPLATE_ID,
    createUcasDefaultModelConfig,
  } = await import("@zcode/provider");
  try {
    const current = await fixture.runtime.configService.read();
    const previousRule = current.personalProviders.getRule(UCAS_PROVIDER_ID)!;
    const { templateId: _templateId, ...legacyRule } = previousRule;
    let models = current.personalModels;
    for (const modelId of UCAS_DEFAULT_MODEL_IDS) {
      models = models.deleteExact(UCAS_PROVIDER_ID, modelId);
    }
    models = models.setExact(
      UCAS_PROVIDER_ID,
      "ucas-gpt-max",
      new ModelConfig({
        enabled: true,
        properties: new ModelPropertiesConfig({ contextWindow: 512_000 }),
      }),
      true,
    );
    models = models.setExact(
      UCAS_PROVIDER_ID,
      "legacy-model",
      new ModelConfig({
        enabled: true,
        properties: new ModelPropertiesConfig({ contextWindow: 32_000 }),
      }),
      true,
    );
    const providers = current.personalProviders.setRule({
      ...legacyRule,
      providerId: UCAS_PROVIDER_ID,
      providerName: "legacy-ucas",
      config: new ProviderConfigValue({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({ apiKey: "preserved-test-key" }),
        api: new ProviderApiConfig({
          type: "openai-responses",
          baseUrl: "https://legacy.example/v1",
          headers: { "x-legacy": "preserved" },
        }),
        personalModelIds: ["legacy-model", "ucas-gpt-max"],
        modelOrder: ["legacy-model", "ucas-gpt-max"],
      }),
    });
    await fixture.runtime.configService.replacePersonalConfig({
      providers,
      models,
      providerOrder: current.personalProviderOrder,
    });

    await fixture.runtime.configService.ensureSeededPersonalProvider({
      providerId: UCAS_PROVIDER_ID,
      templateId: UCAS_PROVIDER_TEMPLATE_ID,
      providerName: UCAS_PROVIDER_NAME,
      modelIds: UCAS_DEFAULT_MODEL_IDS,
      modelConfig: createUcasDefaultModelConfig(),
    });
    await fixture.service.refresh("legacy-ucas-migrated");

    const migrated = requireProvider(await fixture.service.getView(), UCAS_PROVIDER_ID);
    assert.equal(migrated.templateId, UCAS_PROVIDER_TEMPLATE_ID);
    assert.equal(migrated.providerName, UCAS_PROVIDER_NAME);
    assert.equal(migrated.effectiveConfig.api?.type, "openai-chat-completions");
    assert.equal(migrated.effectiveConfig.api?.baseUrl, "https://lm.ucas.com.cn:15000/v1");
    assert.equal(migrated.personalConfig?.access?.apiKey, "preserved-test-key");
    assert.equal(migrated.personalConfig?.api?.headers?.["x-legacy"], "preserved");
    assert.deepEqual(
      migrated.models.map((model) => model.modelId),
      [
        "legacy-model",
        "ucas-gpt-max",
        ...UCAS_DEFAULT_MODEL_IDS.filter((modelId) => modelId !== "ucas-gpt-max"),
      ],
    );
    assert.equal(
      migrated.models.find((model) => model.modelId === "legacy-model")?.effectiveConfig.properties
        ?.contextWindow,
      32_000,
    );
    assert.equal(
      migrated.models.find((model) => model.modelId === "ucas-gpt-max")?.effectiveConfig.properties
        ?.contextWindow,
      512_000,
    );
  } finally {
    await fixture.dispose();
  }
});

test("a prior custom provider named UCAS merges into the default identity without losing selection", async () => {
  const fixture = await runtimeFixture(async () => []);
  const { readFile } = await import("node:fs/promises");
  const {
    ApiKeyAccessConfig,
    EnumOptionSpecConfig,
    ModelConfig,
    ModelOptionSpecsConfig,
    ModelPropertiesConfig,
    ProviderApiConfig,
    ProviderConfig: ProviderConfigValue,
    UCAS_DEFAULT_MODEL_IDS,
    UCAS_PROVIDER_ID,
    UCAS_PROVIDER_NAME,
    UCAS_PROVIDER_TEMPLATE_ID,
    createUcasDefaultModelConfig,
  } = await import("@zcode/provider");
  const legacyId = "legacy-ucas-provider";
  try {
    const current = await fixture.runtime.configService.read();
    const providers = current.personalProviders.setRule({
      providerId: legacyId,
      providerName: "ucas",
      enabled: false,
      config: new ProviderConfigValue({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({ apiKey: "preserved-alias-key" }),
        api: new ProviderApiConfig({
          type: "openai-responses",
          baseUrl: "https://legacy.example/v1",
          headers: { "x-legacy": "preserved" },
        }),
        personalModelIds: ["legacy-model", "ucas-gpt-max"],
        modelOrder: ["legacy-model", "ucas-gpt-max"],
      }),
    });
    let models = current.personalModels
      .setExact(
        legacyId,
        "legacy-model",
        new ModelConfig({
          enabled: true,
          properties: new ModelPropertiesConfig({ contextWindow: 32_000 }),
        }),
        true,
      )
      .setExact(
        legacyId,
        "ucas-gpt-max",
        new ModelConfig({
          enabled: true,
          properties: new ModelPropertiesConfig({ contextWindow: 512_000 }),
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: new EnumOptionSpecConfig({ values: ["low", "high", "max"] }),
          }),
        }),
        true,
      );
    await fixture.runtime.configService.replacePersonalConfig({
      providers,
      models,
      providerOrder: [legacyId, UCAS_PROVIDER_ID],
      defaultModelSelection: {
        providerId: legacyId,
        modelId: "ucas-gpt-max",
        options: { reasoningLevel: "max" },
      },
    });

    await fixture.runtime.configService.ensureSeededPersonalProvider({
      providerId: UCAS_PROVIDER_ID,
      templateId: UCAS_PROVIDER_TEMPLATE_ID,
      providerName: UCAS_PROVIDER_NAME,
      modelIds: UCAS_DEFAULT_MODEL_IDS,
      modelConfig: createUcasDefaultModelConfig(),
    });
    await fixture.service.refresh("legacy-ucas-alias-migrated");

    const view = await fixture.service.getView();
    const migrated = requireProvider(view, UCAS_PROVIDER_ID);
    assert.equal(
      view.providers.some((provider) => provider.providerId === legacyId),
      false,
    );
    assert.equal(view.providers.filter((provider) => provider.providerName === "ucas").length, 1);
    assert.equal(migrated.enabled, false);
    assert.equal(migrated.personalConfig?.access?.apiKey, "preserved-alias-key");
    assert.equal(migrated.personalConfig?.api?.headers?.["x-legacy"], "preserved");
    assert.deepEqual(
      migrated.models.map((model) => model.modelId),
      [
        "legacy-model",
        "ucas-gpt-max",
        ...UCAS_DEFAULT_MODEL_IDS.filter((modelId) => modelId !== "ucas-gpt-max"),
      ],
    );
    assert.equal(
      migrated.models.find((model) => model.modelId === "legacy-model")?.effectiveConfig.properties
        ?.contextWindow,
      32_000,
    );
    assert.equal(
      migrated.models.find((model) => model.modelId === "ucas-gpt-max")?.effectiveConfig.properties
        ?.contextWindow,
      512_000,
    );
    const stored = JSON.parse(await readFile(fixture.personalFilePath, "utf8"));
    assert.deepEqual(stored.config.defaultModelSelection, {
      providerId: UCAS_PROVIDER_ID,
      modelId: "ucas-gpt-max",
      options: { reasoningLevel: "max" },
    });
    assert.equal(view.providerOrder[0], UCAS_PROVIDER_ID);
    assert.equal(view.providerOrder.includes(legacyId), false);
  } finally {
    await fixture.dispose();
  }
});

test("UCAS connection is immutable while its API key can be saved", async () => {
  const fixture = await runtimeFixture(async () => []);
  try {
    await assert.rejects(
      fixture.service.savePersonalProviderOverlay("ucas", {
        api: { type: "openai-chat-completions", baseUrl: "https://changed.example/v1" },
      }),
      /UCAS.*固定/,
    );
    await assert.rejects(
      fixture.service.savePersonalProviderOverlay("ucas", {
        api: { type: "anthropic-messages" },
      }),
      /UCAS.*固定/,
    );
    await assert.rejects(
      fixture.service.savePersonalProviderOverlay(
        "ucas",
        { access: { type: "api-key", apiKey: "test-key" } },
        { providerName: "Renamed UCAS" },
      ),
      /UCAS.*固定/,
    );
    await fixture.service.savePersonalProviderOverlay("ucas", {
      access: { type: "api-key", apiKey: "ucas-test-key" },
    });
    assert.equal(
      requireProvider(await fixture.service.getView(), "ucas").personalConfig?.access?.apiKey,
      "ucas-test-key",
    );
    await assert.rejects(fixture.service.deletePersonalProvider("ucas"), /UCAS.*删除/);
  } finally {
    await fixture.dispose();
  }
});

test("concurrent Host startup seeds UCAS once and preserves its saved key on restart", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { createProviderRuntime } = await import("../src/model-provider/providerRuntime.js");
  const dir = await mkdtemp(join(tmpdir(), "ucas-seed-race-"));
  const options = {
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false as const,
    watch: false,
  };
  const first = createProviderRuntime(options);
  const second = createProviderRuntime(options);
  try {
    await Promise.all([first.start(), second.start()]);
    const providers = (await first.providerSettings.getView()).providers;
    assert.equal(providers.filter((provider) => provider.providerId === "ucas").length, 1);
    await first.providerSettings.savePersonalProviderOverlay("ucas", {
      access: { type: "api-key", apiKey: "restart-test-key" },
    });
    first.dispose();
    const restarted = createProviderRuntime(options);
    try {
      await restarted.start();
      const ucas = requireProvider(await restarted.providerSettings.getView(), "ucas");
      assert.equal(ucas.personalConfig?.access?.apiKey, "restart-test-key");
      assert.equal(ucas.models.length, 6);
    } finally {
      restarted.dispose();
    }
  } finally {
    second.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
