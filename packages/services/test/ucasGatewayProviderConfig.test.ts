import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderTemplate,
  ProviderTemplateMap,
  UCAS_BASE_URL,
  createUcasDefaultModelConfig,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
  type ProviderSource,
} from "@zcode/provider";

const UCAS_TEMPLATE_BASE_URL = UCAS_BASE_URL;

function createBuiltinSource(): ProviderSource<ProviderConfigLayerSnapshot> {
  const templates = new ProviderTemplateMap([
    [
      "ucas",
      new ProviderTemplate({
        templateId: "ucas",
        templateNameMap: { "zh-CN": "ucas", "en-US": "ucas" },
        config: new ProviderConfig({
          access: new ApiKeyAccessConfig(),
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: UCAS_TEMPLATE_BASE_URL,
          }),
        }),
      }),
    ],
  ]);
  return {
    read: async () => ({
      revision: "builtin-1",
      providers: ProviderConfigMap.empty(),
      providerTemplates: templates,
      models: ModelConfigRules.empty(),
    }),
    onDidChange: () => () => {},
  };
}

function createMemoryRepository() {
  let snapshot: ProviderConfigLayerSnapshot = {
    revision: "personal-0",
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  };
  const listeners = new Set<(reason: string) => void>();
  return {
    async read() {
      return snapshot;
    },
    async update(transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate) {
      const update = transform(snapshot);
      snapshot = {
        revision: `personal-${Number(snapshot.revision.split("-")[1]) + 1}`,
        providers: update.providers,
        models: update.models,
        providerOrder: update.providerOrder,
        defaultModelSelection: update.defaultModelSelection,
      };
      for (const listener of listeners) listener("updated");
      return snapshot;
    },
    onDidChange(listener: (reason: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function setup(override?: string) {
  const repository = createMemoryRepository();
  let endpoint = override;
  const service = new ProviderConfigService({
    zcodeBuiltinSource: createBuiltinSource(),
    personalRepository: repository,
    ucasEndpointSource: {
      read: async () => endpoint,
    },
  });
  return {
    service,
    repository,
    setEndpoint: (value: string | undefined) => {
      endpoint = value;
    },
  };
}

async function seed(service: ProviderConfigService): Promise<void> {
  await service.ensureSeededPersonalProvider({
    providerId: "ucas",
    templateId: "ucas",
    providerName: "ucas",
    modelIds: ["ucas-glm"],
    modelConfig: createUcasDefaultModelConfig(),
  });
}

function ucasRule(snapshot: ProviderConfigLayerSnapshot) {
  const rule = snapshot.providers.getRule("ucas");
  assert.ok(rule, "ucas provider rule must exist");
  return rule;
}

test("seeding resolves the gateway endpoint override over the bundled default", async () => {
  const { service, repository, setEndpoint } = setup();
  await seed(service);
  assert.equal(ucasRule(await repository.read()).config.api?.baseUrl, UCAS_TEMPLATE_BASE_URL);

  setEndpoint("http://llm.internal.example:14000");
  await seed(service);
  assert.equal(
    ucasRule(await repository.read()).config.api?.baseUrl,
    "http://llm.internal.example:14000/v1",
  );
});

test("gateway writing fills a missing key and keeps an existing one until replaced", async () => {
  const { service } = setup("http://llm.internal.example:14000");
  await seed(service);

  const applied = await service.applyUcasGatewayConfig({
    baseUrl: "http://llm.internal.example:14000",
    apiKey: "sk-first",
  });
  assert.equal(applied.apiKeyApplied, true);
  assert.equal(
    ucasRule(applied.snapshot).config.access?.type === "api-key"
      ? ucasRule(applied.snapshot).config.access?.apiKey
      : undefined,
    "sk-first",
  );
  assert.equal(
    ucasRule(applied.snapshot).config.api?.baseUrl,
    "http://llm.internal.example:14000/v1",
  );

  const kept = await service.applyUcasGatewayConfig({
    baseUrl: "https://llm.example.com:15000",
    apiKey: "sk-second",
  });
  assert.equal(kept.apiKeyApplied, false);
  const keptAccess = ucasRule(kept.snapshot).config.access;
  assert.equal(keptAccess?.type === "api-key" ? keptAccess.apiKey : undefined, "sk-first");
  assert.equal(ucasRule(kept.snapshot).config.api?.baseUrl, "https://llm.example.com:15000/v1");

  const replaced = await service.applyUcasGatewayConfig({
    baseUrl: "https://llm.example.com:15000",
    apiKey: "sk-third",
    replaceApiKey: true,
  });
  assert.equal(replaced.apiKeyApplied, true);
  const replacedAccess = ucasRule(replaced.snapshot).config.access;
  assert.equal(replacedAccess?.type === "api-key" ? replacedAccess.apiKey : undefined, "sk-third");
});

test("provider overlay saves accept the resolved gateway endpoint and reject other addresses", async () => {
  const { service, repository } = setup("http://llm.internal.example:14000");
  await seed(service);
  const rule = ucasRule(await repository.read());

  const accepted = await service.savePersonalProviderOverlay(
    "ucas",
    rule.config.overlay(
      new ProviderConfig({
        api: rule.config.api?.overlay(
          new ProviderApiConfig({ baseUrl: "http://llm.internal.example:14000/v1" }),
        ),
      }),
    ),
  );
  assert.equal(ucasRule(accepted).config.api?.baseUrl, "http://llm.internal.example:14000/v1");

  await assert.rejects(
    service.savePersonalProviderOverlay(
      "ucas",
      rule.config.overlay(
        new ProviderConfig({
          api: rule.config.api?.overlay(
            new ProviderApiConfig({ baseUrl: "https://evil.example/v1" }),
          ),
        }),
      ),
    ),
    /Base URL/,
  );
});
