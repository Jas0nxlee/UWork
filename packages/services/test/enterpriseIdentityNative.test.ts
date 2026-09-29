import assert from "node:assert/strict";
import test from "node:test";
import { createEnterpriseIdentityService } from "../src/enterprise-identity/enterpriseIdentityService.js";

const id = "fixture-random-state";
const callback = "https://auth.example.com/callback";
const attempt = {
  id,
  callbackUrl: callback,
  authorizationUrl: `https://login.work.weixin.qq.com/wwlogin/sso/login?state=${id}&redirect_uri=${encodeURIComponent(callback)}`,
  expiresAt: 1500,
};
const session = {
  profile: {
    id: "fixture-user",
    tenantId: "fixture-org",
    provider: "wecom" as const,
    displayName: "Fixture",
  },
  token: "fixture-token",
  expiresAt: 2000,
};
function setup() {
  const values = new Map<string, string>();
  let exchanges = 0;
  const service = createEnterpriseIdentityService({
    now: () => 1000,
    credentials: {
      load: async (k) => values.get(k) ?? null,
      save: async (k, v) => {
        values.set(k, v);
      },
      delete: async (k) => {
        values.delete(k);
      },
    },
    adapter: {
      start: async () => attempt,
      complete: async () => {
        exchanges++;
        return session;
      },
      restore: async () => session,
    },
  });
  return { service, values, count: () => exchanges };
}
test("native callback is exchanged once and publishes verified profile", async () => {
  const { service, count } = setup();
  await service.beginLogin();
  const url = `${callback}?code=fixture-code&state=${id}`;
  await Promise.all([service.completeLogin(id, url), service.completeLogin(id, url)]);
  assert.equal(count(), 1);
  assert.equal((await service.getView()).profile?.displayName, "Fixture");
});
test("wrong state, duplicate code and origin mismatch do not consume authorization code", async () => {
  const { service, count } = setup();
  await service.beginLogin();
  for (const url of [
    `${callback}?code=c&state=wrong`,
    `${callback}?code=c&code=d&state=${id}`,
    `https://attacker.example/callback?code=c&state=${id}`,
  ])
    await assert.rejects(service.completeLogin(id, url));
  assert.equal(count(), 0);
});
test("cancelled native callback cannot authenticate or write credentials", async () => {
  const { service, values, count } = setup();
  await service.beginLogin();
  await service.cancelLogin(id);
  await service.completeLogin(id, `${callback}?code=c&state=${id}`);
  assert.equal(count(), 0);
  assert.equal(values.size, 0);
});

test("duplicate begin during native exchange reuses attempt and cancellation still aborts it", async () => {
  let resolve!: (value: typeof session) => void;
  const pending = new Promise<typeof session>((done) => {
    resolve = done;
  });
  let starts = 0;
  let activeSignal: AbortSignal | undefined;
  const values = new Map<string, string>();
  const service = createEnterpriseIdentityService({
    now: () => 1000,
    credentials: {
      load: async (key) => values.get(key) ?? null,
      save: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
    adapter: {
      start: async () => {
        starts++;
        return attempt;
      },
      complete: async (_code, signal) => {
        activeSignal = signal;
        return pending;
      },
      restore: async () => session,
    },
  });
  await service.beginLogin();
  const completing = service.completeLogin(id, `${callback}?code=c&state=${id}`);
  await service.beginLogin();
  assert.equal(starts, 1);
  assert.equal(activeSignal?.aborted, false);
  await service.cancelLogin(id);
  assert.equal(activeSignal?.aborted, true);
  resolve(session);
  await completing;
  assert.equal(values.size, 0);
  assert.equal((await service.getView()).status, "signed-out");
});
