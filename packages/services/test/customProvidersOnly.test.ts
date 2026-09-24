import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createOAuthService } from "../src/oauth/oauthService.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";

const values = new Map([
  ["oauth:active_provider", "bigmodel"],
  ["oauth:bigmodel:access_token", "old-test-token"],
  ["oauth:bigmodel:user_info", JSON.stringify({ id: "test-user", username: "test" })],
  ["custom-api-key", "personal-test-key"],
]);
const credentials = {
  load: async (key: string) => values.get(key) ?? null,
  save: async (key: string, value: string) => {
    values.set(key, value);
  },
  delete: async (key: string) => {
    values.delete(key);
  },
};

test("retired account RPC cannot restore credentials or initiate network login", async () => {
  let requests = 0;
  const service = createOAuthService(credentials, {
    apiClient: {
      request: async () => {
        requests++;
        throw new Error("Unexpected network");
      },
    },
  });
  assert.deepEqual(await service.getProviders(), []);
  assert.equal(await service.getActiveProvider(), null);
  assert.deepEqual(await service.restoreCachedSessionState(), { status: "signed-out" });
  assert.equal(await service.restoreSession(), null);
  await assert.rejects(service.startOAuth("bigmodel"), /removed|移除/);
  await assert.rejects(service.startOAuthWithPolling("zai"), /removed|移除/);
  await assert.rejects(service.refreshToken(), /removed|移除/);
  assert.equal(await service.handleCallback("zcode://oauth/callback?code=test&state=test"), null);
  assert.equal(await service.pollPendingOAuth(), null);
  assert.equal(requests, 0);
  assert.equal(await credentials.load("custom-api-key"), "personal-test-key");
});

test("historical OAuth account reads do not feed provider APIs or mutate personal keys", async () => {
  const repo = new OAuthCredentialRepo(credentials);
  assert.equal(await repo.getActiveProvider(), null);
  assert.equal(await repo.loadTokenSet("bigmodel"), null);
  assert.equal(await repo.loadUserProfile("bigmodel"), null);
  assert.equal(await repo.loadActiveUserProfile(), null);
  assert.equal(await credentials.load("custom-api-key"), "personal-test-key");
});

test("bundled catalog keeps UCAS and other templates without account providers or Zhipu templates", async () => {
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  const rules = release.config.providerConfigRules;
  assert.deepEqual(rules.providerRules, []);
  assert.ok(
    rules.templateRules.some((rule: { templateId: string }) => rule.templateId === "openai"),
  );
  const ucas = rules.templateRules.find(
    (rule: { templateId: string }) => rule.templateId === "ucas",
  );
  assert.ok(ucas);
  assert.equal(ucas.config.api.baseUrl, "https://lm.ucas.com.cn:15000/v1");
  assert.equal(ucas.config.api.type, "openai-chat-completions");
  assert.equal(ucas.config.access.apiKey, undefined);
  assert.equal(
    rules.templateRules.some((rule: { templateId: string }) =>
      /bigmodel|zai/.test(rule.templateId),
    ),
    false,
  );
});

test("retired subscription RPC never contacts pricing, billing or remote feature configuration", async () => {
  const { createCodingPlanSubscriptionService } =
    await import("../src/coding-plan-subscription/codingPlanSubscriptionService.js");
  let requests = 0;
  const service = createCodingPlanSubscriptionService({
    credentialService: credentials,
    apiClient: {
      request: async () => {
        requests++;
        throw new Error("Unexpected network");
      },
    },
  });
  assert.equal(await service.getStartPlanPreview(), null);
  assert.equal(await service.getForceUpdateConfig(), null);
  await service.getDynamicWorkflowClientConfig();
  await assert.rejects(service.getStaticProducts(), /移除/);
  await assert.rejects(service.getEnterprisePricing(), /移除/);
  assert.equal(requests, 0);
});

test("credential service isolates retired account namespaces while preserving disk and custom keys", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { setDataBaseDir, getAppConfigDir } = await import("../src/paths.js");
  const { createCredentialService } = await import("../src/credential/credentialService.js");
  const directory = await mkdtemp(join(tmpdir(), "zcode-retired-account-"));
  setDataBaseDir(directory);
  try {
    const service = createCredentialService({
      cipherProvider: { encrypt: (value) => value, decrypt: (value) => value },
    });
    for (const key of [
      "oauth:active_provider",
      "oauth:bigmodel:access_token",
      "zcodejwttoken",
      "account-provider:example:api-key",
      "custom-api-key",
    ])
      await service.save(key, "test-only");
    const before = await readFile(join(getAppConfigDir(), "credentials.json"), "utf8");
    assert.equal(await service.load("custom-api-key"), "test-only");
    for (const key of [
      "oauth:active_provider",
      "oauth:bigmodel:access_token",
      "zcodejwttoken",
      "account-provider:example:api-key",
    ])
      assert.equal(await service.load(key), null);
    assert.equal(await readFile(join(getAppConfigDir(), "credentials.json"), "utf8"), before);
  } finally {
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});
