import assert from "node:assert/strict";
import test from "node:test";
import { createWeComIdentityAdapter } from "../src/enterprise-identity/wecomIdentityAdapter.js";

const config = {
  orgId: "fixture-org",
  corpId: "wx-fixture-corp",
  agentId: "1000001",
  apiBaseUrl: "https://auth.example.com",
  callbackUrl: "https://auth.example.com/callback",
};
const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 2000 })).toString("base64url")}.fixture`;
const response = {
  token,
  user: { id: "fixture-user", org_id: "fixture-org", name: "测试用户" },
  needsEmailAuth: false,
};

test("standard WeCom link keeps issuer organization state and binds a random callback nonce", async () => {
  const adapter = createWeComIdentityAdapter(config, {
    now: () => 1000,
    fetchImpl: async () => {
      throw new Error("unexpected network");
    },
  });
  const attempt = await adapter.start(new AbortController().signal);
  const url = new URL(attempt.authorizationUrl);
  assert.equal(url.origin, "https://login.work.weixin.qq.com");
  assert.equal(url.searchParams.get("login_type"), "CorpApp");
  assert.equal(url.searchParams.get("appid"), config.corpId);
  assert.equal(url.searchParams.get("agentid"), config.agentId);
  assert.equal(url.searchParams.get("state"), config.orgId);
  assert.equal(attempt.expectedState, config.orgId);
  const callback = new URL(attempt.callbackUrl!);
  assert.equal(callback.origin, new URL(config.callbackUrl).origin);
  assert.equal(callback.pathname, "/callback");
  assert.equal(callback.searchParams.get("uwork_nonce"), attempt.id);
  assert.equal(url.searchParams.get("redirect_uri"), callback.href);
  assert.equal(attempt.expiresAt, 301000);
});

test("existing login/refresh endpoints validate user and expiration without exposing raw response", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = createWeComIdentityAdapter(config, {
    now: () => 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const session = await adapter.complete!("fixture-code", new AbortController().signal);
  assert.deepEqual(session.profile, {
    id: "fixture-user",
    tenantId: "fixture-org",
    provider: "wecom",
    displayName: "测试用户",
  });
  assert.equal(session.expiresAt, 2000000);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    code: "fixture-code",
    org_id: config.orgId,
  });
  assert.equal(calls[0].url, "https://auth.example.com/api/auth/login");
  assert.equal(calls[0].init?.redirect, "error");
  await adapter.restore(session, new AbortController().signal);
  assert.equal(calls[1].url, "https://auth.example.com/api/auth/refresh");
  assert.equal(new Headers(calls[1].init?.headers).get("Authorization"), `Bearer ${token}`);
});

test("unsigned-shaped and missing-name responses never authenticate", async () => {
  for (const value of [
    { ...response, token: "opaque-without-expiry" },
    { ...response, user: { ...response.user, name: "" } },
  ]) {
    const adapter = createWeComIdentityAdapter(config, {
      now: () => 1000,
      fetchImpl: async () => new Response(JSON.stringify(value)),
    });
    await assert.rejects(adapter.complete!("fixture-code", new AbortController().signal));
  }
  const denied = createWeComIdentityAdapter(config, {
    fetchImpl: async () => new Response("Unauthorized", { status: 401 }),
  });
  assert.equal(
    await denied.restore(
      {
        profile: { id: "u", tenantId: "c", provider: "wecom", displayName: "Fixture" },
        token,
        expiresAt: 2000000,
      },
      new AbortController().signal,
    ),
    null,
  );
});

test("HTTP, embedded credentials and callback outside issuer origin are rejected", () => {
  for (const patch of [
    { apiBaseUrl: "http://auth.example.com" },
    { callbackUrl: "https://attacker.example/callback" },
    { apiBaseUrl: "https://user:pass@auth.example.com" },
  ]) {
    assert.throws(() => createWeComIdentityAdapter({ ...config, ...patch }));
  }
});

test("missing issuer organization is rejected before displaying a QR code", () => {
  const { orgId: _orgId, ...missing } = config;
  assert.throws(() => createWeComIdentityAdapter(missing));
});

test("issuer diagnostics distinguish rejection and malformed responses without exposing values", async () => {
  for (const fixture of [
    {
      status: 400,
      body: { error: "invalid code fixture-sensitive-token" },
      expected: { reason: "http-rejected", status: 400, category: "authorization-code" },
    },
    {
      status: 200,
      body: { ...response, user: { id: "fixture-person", org_id: "fixture-org" } },
      expected: { reason: "response-schema", fields: ["user.name"] },
    },
    {
      status: 200,
      body: { ...response, token: "fixture-sensitive-token" },
      expected: { reason: "token-format" },
    },
  ]) {
    const events: unknown[] = [];
    const adapter = createWeComIdentityAdapter(config, {
      now: () => 1000,
      fetchImpl: async () => new Response(JSON.stringify(fixture.body), { status: fixture.status }),
      onDiagnostic: (event) => events.push(event),
    });
    await assert.rejects(adapter.complete!("fixture-code", new AbortController().signal));
    assert.deepEqual(events, [fixture.expected]);
    assert.doesNotMatch(JSON.stringify(events), /fixture|测试用户|eyJ/);
  }
});

test("email-enrichment flag requires issuer refresh before accepting a name-only session", async () => {
  const paths: string[] = [];
  const adapter = createWeComIdentityAdapter(config, {
    now: () => 1000,
    fetchImpl: async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      if (paths.length === 2)
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
      return new Response(JSON.stringify({ ...response, needsEmailAuth: true }));
    },
  });
  const session = await adapter.complete!("fixture-code", new AbortController().signal);
  assert.equal(session.profile.displayName, response.user.name);
  assert.deepEqual(paths, ["/api/auth/login", "/api/auth/refresh"]);
});

test("email-enrichment session cannot authenticate if refresh rejects or changes identity", async () => {
  for (const renewed of [
    new Response("denied", { status: 401 }),
    new Response(JSON.stringify({ ...response, user: { ...response.user, id: "other-user" } })),
    new Response(JSON.stringify({ ...response, user: { ...response.user, org_id: "other-org" } })),
  ]) {
    let calls = 0;
    const adapter = createWeComIdentityAdapter(config, {
      now: () => 1000,
      fetchImpl: async () =>
        ++calls === 1
          ? new Response(JSON.stringify({ ...response, needsEmailAuth: true }))
          : renewed,
      onDiagnostic: () => {},
    });
    await assert.rejects(adapter.complete!("fixture-code", new AbortController().signal));
    assert.equal(calls, 2);
  }
});
