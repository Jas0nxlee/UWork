import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWeComIdentityAdapter } from "../src/enterprise-identity/wecomIdentityConfig.js";
import { createWeComIdentityAdapter } from "../src/enterprise-identity/wecomIdentityAdapter.js";

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

const multiOrgConfig = {
  apiBaseUrl: "https://auth.example.com",
  callbackUrl: "https://auth.example.com/callback",
  defaultOrgId: "fixture-nj",
  organizations: [
    { orgId: "fixture-bj", corpId: "wx-fixture-bj", agentId: "1000001", label: "北京" },
    { orgId: "fixture-nj", corpId: "ww-fixture-nj", agentId: "1000002", label: "南京" },
    { orgId: "fixture-xm", corpId: "ww-fixture-xm", agentId: "1000003" },
  ],
};

test("a multi-org configuration lists organizations and signs in with the selected one", async () => {
  await fixture(async (local, builtin) => {
    await writeFile(builtin, JSON.stringify(multiOrgConfig));
    const adapter = await loadWeComIdentityAdapter(local, fetch, builtin);
    assert.ok(adapter);
    assert.deepEqual(adapter.listOrganizations(), [
      { id: "fixture-bj", label: "北京" },
      { id: "fixture-nj", label: "南京" },
      { id: "fixture-xm" },
    ]);
    // 缺省时用 defaultOrgId；显式指定则必须命中清单。
    assert.equal(adapter.resolveOrganization()?.id, "fixture-nj");
    assert.equal(adapter.resolveOrganization("fixture-xm")?.id, "fixture-xm");
    assert.equal(adapter.resolveOrganization("fixture-unknown"), undefined);

    const attempt = await adapter.start(new AbortController().signal, "fixture-xm");
    const url = new URL(attempt.authorizationUrl);
    assert.equal(url.searchParams.get("appid"), "ww-fixture-xm");
    assert.equal(url.searchParams.get("agentid"), "1000003");
    assert.equal(url.searchParams.get("state"), "fixture-xm");
    assert.equal(attempt.expectedState, "fixture-xm");

    await assert.rejects(
      adapter.start(new AbortController().signal, "fixture-unknown"),
      /organization is not configured/u,
    );

    // 回包组织与本次请求的组织不一致时必须拒绝（不落会话）。
    const mismatched = createWeComIdentityAdapter(multiOrgConfig, {
      now: () => 1000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            token: "eyJ7fQ.eyJleHAiOjIwMDB9.fixture" /* header.payload.signature 形状 */,
            user: { id: "u", org_id: "fixture-nj", name: "测试" },
            needsEmailAuth: false,
          }),
        ),
    });
    await assert.rejects(
      mismatched.complete!("fixture-code", new AbortController().signal, "fixture-bj"),
      /organization mismatch/u,
    );
  });
});

test("organization list rejects duplicates and a default that is not listed", async () => {
  await fixture(async (local, builtin) => {
    await writeFile(
      builtin,
      JSON.stringify({
        ...multiOrgConfig,
        organizations: [
          multiOrgConfig.organizations[0],
          { orgId: "fixture-bj", corpId: "ww-duplicate", agentId: "1000009" },
        ],
      }),
    );
    await assert.rejects(loadWeComIdentityAdapter(local, fetch, builtin));
    await writeFile(
      builtin,
      JSON.stringify({ ...multiOrgConfig, defaultOrgId: "fixture-missing" }),
    );
    await assert.rejects(loadWeComIdentityAdapter(local, fetch, builtin));
  });
});
