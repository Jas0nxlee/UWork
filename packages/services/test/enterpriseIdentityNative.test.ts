import assert from "node:assert/strict";
import test from "node:test";
import type { EnterpriseIdentityPollResult } from "@zcode/shared";
import {
  createEnterpriseIdentityService,
  disposeEnterpriseIdentityService,
} from "../src/enterprise-identity/enterpriseIdentityService.js";

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
  const results = await Promise.all([
    service.completeLogin(id, url),
    service.completeLogin(id, url),
  ]);
  assert.deepEqual(
    results.map((result) => result.committedAttemptId),
    [id, id],
  );
  assert.equal(results[0]?.view.status, "authenticated");
  assert.equal(count(), 1);
  assert.equal((await service.getView()).profile?.displayName, "Fixture");
  const stale = await service.completeLogin(id, url);
  assert.equal(stale.committedAttemptId, null);
  assert.equal(stale.view.status, "authenticated");
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
  const stale = await service.completeLogin(id, `${callback}?code=c&state=${id}`);
  assert.equal(stale.committedAttemptId, null);
  assert.equal(stale.view.status, "signed-out");
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setupPollRace(nativeResult?: Promise<typeof session>) {
  const polled = deferred<EnterpriseIdentityPollResult>();
  const pollStarted = deferred<void>();
  const values = new Map<string, string>();
  let exchanges = 0;
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
      listOrganizations: () => [],
      resolveOrganization: () => undefined,
      start: async () => attempt,
      poll: async () => {
        pollStarted.resolve();
        return polled.promise;
      },
      complete: async () => {
        exchanges++;
        return nativeResult ?? session;
      },
      restore: async () => session,
    },
  });
  return { service, polled, pollStarted, values, count: () => exchanges };
}

test("native callback arriving during a pending poll commits once, including duplicate callbacks", async () => {
  const { service, polled, pollStarted, values, count } = setupPollRace();
  try {
    await service.beginLogin();
    const polling = service.pollLogin(id);
    await pollStarted.promise;
    const url = `${callback}?code=fixture-code&state=${id}`;
    const completing = service.completeLogin(id, url);
    const duplicate = service.completeLogin(id, url);

    polled.resolve({ status: "pending" });
    const [, result, repeated] = await Promise.all([polling, completing, duplicate]);

    assert.equal(result.view.status, "authenticated");
    assert.equal(result.committedAttemptId, id);
    assert.deepEqual(repeated, result);
    assert.equal(count(), 1);
    assert.equal(values.size, 1);
    assert.equal((await service.getView()).profile?.id, session.profile.id);
  } finally {
    await disposeEnterpriseIdentityService(service);
  }
});

test("a failed in-flight poll does not discard an already received native callback", async () => {
  const { service, polled, pollStarted, values, count } = setupPollRace();
  try {
    await service.beginLogin();
    const polling = service.pollLogin(id).catch(() => null);
    await pollStarted.promise;
    const completing = service.completeLogin(id, `${callback}?code=fixture-code&state=${id}`);

    polled.reject(new Error("fixture temporary poll failure"));
    const [, result] = await Promise.all([polling, completing]);

    assert.equal(result.view.status, "authenticated");
    assert.equal(result.committedAttemptId, id);
    assert.equal(count(), 1);
    assert.equal(values.size, 1);
  } finally {
    await disposeEnterpriseIdentityService(service);
  }
});

test("a native callback received after polling authenticates is ignored as a duplicate", async () => {
  const { service, polled, pollStarted, values, count } = setupPollRace();
  try {
    await service.beginLogin();
    const polling = service.pollLogin(id);
    await pollStarted.promise;
    polled.resolve({ status: "authenticated", session });
    const polledView = await polling;
    const result = await service.completeLogin(id, `${callback}?code=fixture-code&state=${id}`);

    assert.equal(polledView.status, "authenticated");
    assert.equal(result.view.status, "authenticated");
    assert.equal(result.committedAttemptId, null);
    assert.equal(count(), 0);
    assert.equal(values.size, 1);
  } finally {
    await disposeEnterpriseIdentityService(service);
  }
});

test("cancelling during native redemption and an in-flight poll rejects both late results", async () => {
  const nativeResult = deferred<typeof session>();
  const { service, polled, pollStarted, values, count } = setupPollRace(nativeResult.promise);
  try {
    await service.beginLogin();
    const polling = service.pollLogin(id);
    await pollStarted.promise;
    const completing = service.completeLogin(id, `${callback}?code=fixture-code&state=${id}`);

    await service.cancelLogin(id);
    polled.resolve({ status: "authenticated", session });
    nativeResult.resolve(session);
    const [, result] = await Promise.all([polling, completing]);

    assert.equal(result.view.status, "signed-out");
    assert.equal(result.committedAttemptId, null);
    assert.equal((await service.getView()).status, "signed-out");
    assert.equal(count(), 1);
    assert.equal(values.size, 0);
  } finally {
    await disposeEnterpriseIdentityService(service);
  }
});
