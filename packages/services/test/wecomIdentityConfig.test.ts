import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWeComIdentityAdapter } from "../src/enterprise-identity/wecomIdentityConfig.js";

const config = {
  corpId: "ww-fixture-corp",
  agentId: "1000001",
  orgId: "fixture-org",
  apiBaseUrl: "https://auth.example.com",
  callbackUrl: "https://auth.example.com/callback",
};
async function fixture(run: (local: string, builtin: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "uwork-identity-config-"));
  try {
    await run(join(dir, "local.json"), join(dir, "builtin.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("a fresh device starts WeCom login from bundled public configuration", async () => {
  await fixture(async (local, builtin) => {
    await writeFile(builtin, JSON.stringify(config));
    const adapter = await loadWeComIdentityAdapter(local, fetch, builtin);
    assert.ok(adapter);
    const attempt = await adapter.start(new AbortController().signal);
    const url = new URL(attempt.authorizationUrl);
    assert.equal(url.searchParams.get("appid"), config.corpId);
    assert.equal(url.searchParams.get("state"), config.orgId);
    assert.ok(attempt.callbackUrl);
  });
});
test("explicit local configuration wins and invalid overrides do not fall back", async () => {
  await fixture(async (local, builtin) => {
    await writeFile(builtin, JSON.stringify(config));
    await writeFile(local, JSON.stringify({ ...config, corpId: "ww-local-corp" }));
    const adapter = await loadWeComIdentityAdapter(local, fetch, builtin);
    assert.ok(adapter);
    const attempt = await adapter.start(new AbortController().signal);
    assert.equal(new URL(attempt.authorizationUrl).searchParams.get("appid"), "ww-local-corp");
    await writeFile(local, "invalid JSON containing fixture-private-value");
    await assert.rejects(loadWeComIdentityAdapter(local, fetch, builtin), (error: Error) => {
      assert.doesNotMatch(error.message, /fixture-private-value/);
      return true;
    });
  });
});
test("missing sources remain unconfigured and bundled secrets are rejected", async () => {
  await fixture(async (local, builtin) => {
    assert.equal(await loadWeComIdentityAdapter(local, fetch, builtin), undefined);
    await writeFile(builtin, JSON.stringify({ ...config, secret: "fixture-secret" }));
    await assert.rejects(loadWeComIdentityAdapter(local, fetch, builtin));
  });
});
