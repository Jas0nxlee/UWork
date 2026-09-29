import assert from "node:assert/strict";
import test from "node:test";
import { createEnterpriseIdentityService } from "../src/enterprise-identity/enterpriseIdentityService.js";
import type { EnterpriseIdentityAdapter } from "../src/enterprise-identity/contract.js";
import { createPublicCredentialService } from "../src/credential/publicCredentialService.js";

const profile = {
  id: "fixture-user",
  tenantId: "fixture-corp",
  provider: "wecom" as const,
  displayName: "测试用户",
};
const session = { profile, token: "fixture-session", expiresAt: 2000 };
const attempt = {
  id: "fixture-attempt",
  authorizationUrl: "https://example.com/login",
  expiresAt: 1500,
};

test("public credential RPC cannot read, replace or remove enterprise sessions", async () => {
  const { credentials, values } = setup();
  values.set("enterprise-identity:session", "fixture-private-session");
  values.set("custom-model-key", "fixture-model-key");
  const publicCredentials = createPublicCredentialService(credentials);
  assert.equal(await publicCredentials.load("enterprise-identity:session"), null);
  await assert.rejects(publicCredentials.save("enterprise-identity:session", "replacement"));
  await assert.rejects(publicCredentials.delete("enterprise-identity:session"));
  assert.equal(await credentials.load("enterprise-identity:session"), "fixture-private-session");
  assert.equal(await publicCredentials.load("custom-model-key"), "fixture-model-key");
});
function setup(adapter?: EnterpriseIdentityAdapter) {
  const values = new Map<string, string>();
  const credentials = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  const service = createEnterpriseIdentityService({ credentials, adapter, now: () => 1000 });
  return { service, values, credentials };
}
function provider(overrides: Partial<EnterpriseIdentityAdapter> = {}): EnterpriseIdentityAdapter {
  return {
    start: async () => attempt,
    poll: async () => ({ status: "authenticated", session }),
    restore: async () => session,
    revoke: async () => {},
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("unconfigured identity is explicitly signed out and never reads credentials", async () => {
  const { service, values } = setup();
  values.set("enterprise-identity:session", "invalid old fixture");
  assert.equal((await service.restoreSession()).configured, false);
  assert.equal((await service.getView()).status, "signed-out");
  await assert.rejects(service.beginLogin(), /未配置/);
  assert.equal(values.size, 1);
});

test("successful login publishes name without token, persists, restores and logs out", async () => {
  const { service, values, credentials } = setup(provider());
  const events: unknown[] = [];
  const listener = service.onDidChange((event) => events.push(event));
  assert.equal((await service.beginLogin()).id, attempt.id);
  const view = await service.pollLogin(attempt.id);
  assert.equal(view.status, "authenticated");
  assert.deepEqual(view.profile, profile);
  assert.equal(values.size, 1);
  assert.doesNotMatch(JSON.stringify(events), /fixture-session|authorizationUrl/);
  const restored = createEnterpriseIdentityService({
    credentials,
    adapter: provider(),
    now: () => 1000,
  });
  assert.deepEqual((await restored.restoreSession()).profile, profile);
  await service.logout();
  assert.equal(values.size, 0);
  assert.equal((await service.getView()).profile, null);
  listener.dispose();
});

test("duplicate starts and polls share one operation", async () => {
  let starts = 0;
  let polls = 0;
  const pending = deferred<{ status: "authenticated"; session: typeof session }>();
  const { service } = setup(
    provider({
      start: async () => {
        starts++;
        return attempt;
      },
      poll: async () => {
        polls++;
        return pending.promise;
      },
    }),
  );
  await Promise.all([service.beginLogin(), service.beginLogin()]);
  const results = [service.pollLogin(attempt.id), service.pollLogin(attempt.id)];
  pending.resolve({ status: "authenticated", session });
  await Promise.all(results);
  assert.equal(starts, 1);
  assert.equal(polls, 1);
});

for (const action of ["cancel", "logout"] as const) {
  test(`${action} rejects late success without writing credentials`, async () => {
    const pending = deferred<{ status: "authenticated"; session: typeof session }>();
    const { service, values } = setup(provider({ poll: async () => pending.promise }));
    await service.beginLogin();
    const polling = service.pollLogin(attempt.id);
    if (action === "cancel") await service.cancelLogin(attempt.id);
    else await service.logout();
    pending.resolve({ status: "authenticated", session });
    await polling;
    assert.equal((await service.getView()).status, "signed-out");
    assert.equal(values.size, 0);
  });
}

test("logout during startup restore cannot revive identity", async () => {
  const pending = deferred<typeof session>();
  const { service, values } = setup(provider({ restore: async () => pending.promise }));
  values.set("enterprise-identity:session", JSON.stringify(session));
  const restoring = service.restoreSession();
  await Promise.resolve();
  await service.logout();
  pending.resolve(session);
  await restoring;
  assert.equal((await service.getView()).profile, null);
  assert.equal(values.size, 0);
});

test("cancelling during credential save removes the unaccepted session", async () => {
  const saving = deferred<void>();
  const entered = deferred<void>();
  const values = new Map<string, string>();
  const service = createEnterpriseIdentityService({
    adapter: provider(),
    now: () => 1000,
    credentials: {
      load: async (key) => values.get(key) ?? null,
      save: async (key, value) => {
        entered.resolve();
        await saving.promise;
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
  });
  await service.beginLogin();
  const polling = service.pollLogin(attempt.id);
  await entered.promise;
  const cancellation = service.cancelLogin();
  saving.resolve();
  await Promise.all([polling, cancellation]);
  assert.equal(values.size, 0);
  assert.equal((await service.getView()).profile, null);
});

test("transport failure keeps encrypted session for retry but shows signed out", async () => {
  const { service, values } = setup(
    provider({
      restore: async () => {
        throw new Error("offline");
      },
    }),
  );
  values.set("enterprise-identity:session", JSON.stringify(session));
  await assert.rejects(service.restoreSession());
  assert.equal(values.size, 1);
  assert.equal((await service.getView()).status, "signed-out");
});

test("a session that expires while the app is open no longer projects a name", async () => {
  let clock = 1000;
  const values = new Map<string, string>();
  const service = createEnterpriseIdentityService({
    adapter: provider(),
    now: () => clock,
    credentials: {
      load: async (key) => values.get(key) ?? null,
      save: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
  });
  await service.beginLogin();
  await service.pollLogin(attempt.id);
  clock = 2001;
  assert.equal((await service.getView()).status, "signed-out");
  assert.equal(values.size, 0);
});

test("expired session and denied restore clear credentials", async () => {
  for (const saved of [{ ...session, expiresAt: 500 }, session]) {
    const { service, values } = setup(provider({ restore: async () => null }));
    values.set("enterprise-identity:session", JSON.stringify(saved));
    assert.equal((await service.restoreSession()).status, "signed-out");
    assert.equal(values.size, 0);
  }
});

test("insecure authorization URL and malformed profile never become authenticated", async () => {
  const { service } = setup(
    provider({ start: async () => ({ ...attempt, authorizationUrl: "javascript:alert(1)" }) }),
  );
  await assert.rejects(service.beginLogin());
  assert.equal((await service.getView()).status, "signed-out");
  const invalid = setup(
    provider({
      poll: async () => ({
        status: "authenticated",
        session: { ...session, profile: { ...profile, displayName: "" } },
      }),
    }),
  );
  await invalid.service.beginLogin();
  await assert.rejects(invalid.service.pollLogin(attempt.id));
  assert.equal(invalid.values.size, 0);
});
