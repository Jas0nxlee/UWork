import assert from "node:assert/strict";
import test from "node:test";
import { createSharedIdentitySessionStore } from "../src/enterprise-identity/identitySessionStore.js";
import { Emitter } from "@zcode/rpc";
import { createEnterpriseIdentityService } from "../src/enterprise-identity/enterpriseIdentityService.js";
import type { BroadcastMessage } from "../src/broadcast/broadcast.js";
import type { IEnterpriseIdentityService } from "../src/enterprise-identity/contract.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import { createCredentialService } from "../src/credential/credentialService.js";
import { setDataBaseDir } from "../src/paths.js";

const profile = { id: "u", tenantId: "c", provider: "wecom" as const, displayName: "Fixture" };
const session = { profile, token: "fixture-session", expiresAt: 2000 };
function setup() {
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
  let queue: Promise<unknown> = Promise.resolve();
  const transaction = <T>(op: () => Promise<T>) => {
    const result = queue.then(op, op);
    queue = result.catch(() => {});
    return result;
  };
  return {
    a: createSharedIdentitySessionStore(credentials, transaction),
    b: createSharedIdentitySessionStore(credentials, transaction),
    values,
    credentials,
  };
}
test("cross-window login uses one revision and only one competing attempt can commit", async () => {
  const { a, b } = setup();
  const results = await Promise.all([
    a.write(session, 0, () => true),
    b.write({ ...session, profile: { ...profile, id: "other" } }, 0, () => true),
  ]);
  assert.deepEqual(
    results.map((r) => r.accepted),
    [true, false],
  );
  assert.equal((await b.read()).session?.profile.id, "u");
});
test("global logout advances tombstone revision and rejects old callbacks", async () => {
  const { a, b } = setup();
  await a.write(null, undefined, () => true);
  assert.equal((await b.write(session, 0, () => true)).accepted, false);
  assert.deepEqual(await b.read(), { revision: 1, session: null });
});
test("stale token renewal cannot overwrite a newer renewal or another login", async () => {
  const { a, b } = setup();
  const first = await a.write(session, 0, () => true);
  const refreshed = { ...session, token: "renewed-fixture" };
  assert.equal((await a.renew(refreshed, first.record, () => true)).accepted, true);
  assert.equal(
    (await b.renew({ ...session, token: "stale-fixture" }, first.record, () => true)).accepted,
    false,
  );
  assert.equal((await a.read()).session?.token, refreshed.token);
  assert.equal((await a.read()).revision, 1);
});

function waitForStatus(
  service: IEnterpriseIdentityService,
  status: "authenticated" | "signed-out",
) {
  return new Promise<void>((resolve) => {
    const listener = service.onDidChange((view) => {
      if (view.status === status) {
        listener.dispose();
        resolve();
      }
    });
  });
}
test("two Host services synchronize login/logout without token/profile broadcast or renewal loops", async () => {
  const stores = setup();
  const channelA = new Emitter<BroadcastMessage>();
  const channelB = new Emitter<BroadcastMessage>();
  const messages: BroadcastMessage[] = [];
  const adapter = {
    start: async () => ({
      id: "fixture",
      authorizationUrl: "https://example.com/login",
      expiresAt: 1500,
    }),
    poll: async () => ({ status: "authenticated" as const, session }),
    restore: async () => session,
  };
  const a = createEnterpriseIdentityService({
    credentials: stores.credentials,
    sessionStore: stores.a,
    adapter,
    now: () => 1000,
    broadcast: {
      onMessage: channelA.event,
      send: async (m) => {
        messages.push(m);
        channelB.fire(m);
      },
    },
  });
  const b = createEnterpriseIdentityService({
    credentials: stores.credentials,
    sessionStore: stores.b,
    adapter,
    now: () => 1000,
    broadcast: {
      onMessage: channelB.event,
      send: async (m) => {
        messages.push(m);
        channelA.fire(m);
      },
    },
  });
  await b.restoreSession();
  const signedIn = waitForStatus(b, "authenticated");
  await a.beginLogin();
  await a.pollLogin("fixture");
  await signedIn;
  assert.equal((await b.getView()).profile?.id, "u");
  const signedOut = waitForStatus(a, "signed-out");
  await b.logout();
  await signedOut;
  assert.equal(messages.length, 2);
  assert.doesNotMatch(JSON.stringify(messages), /fixture-session|Fixture|displayName/);
  assert.equal((await a.getView()).profile, null);
});
test("stale native callback returns peer-authenticated view without a local commit marker", async () => {
  const stores = setup();
  const channelA = new Emitter<BroadcastMessage>();
  const nativeId = "fixture-native-state";
  const callback = "https://auth.example.com/callback";
  let nativeExchanges = 0;
  const a = createEnterpriseIdentityService({
    credentials: stores.credentials,
    sessionStore: stores.a,
    now: () => 1000,
    adapter: {
      start: async () => ({
        id: nativeId,
        callbackUrl: callback,
        authorizationUrl: `https://login.work.weixin.qq.com/wwlogin/sso/login?state=${nativeId}`,
        expiresAt: 1500,
      }),
      complete: async () => {
        nativeExchanges++;
        return session;
      },
      restore: async () => session,
    },
    broadcast: {
      onMessage: channelA.event,
      send: async () => {},
    },
  });
  const b = createEnterpriseIdentityService({
    credentials: stores.credentials,
    sessionStore: stores.b,
    now: () => 1000,
    adapter: {
      start: async () => ({
        id: "peer-poll",
        authorizationUrl: "https://example.com/login",
        expiresAt: 1500,
      }),
      poll: async () => ({ status: "authenticated", session }),
      restore: async () => session,
    },
    broadcast: {
      onMessage: () => ({ dispose() {} }),
      send: async (message) => channelA.fire(message),
    },
  });

  await a.beginLogin();
  const peerAuthenticated = waitForStatus(a, "authenticated");
  await b.beginLogin();
  await b.pollLogin("peer-poll");
  await peerAuthenticated;
  const stale = await a.completeLogin(nativeId, `${callback}?code=old-code&state=${nativeId}`);
  assert.equal(stale.view.status, "authenticated");
  assert.equal(stale.committedAttemptId, null);
  assert.equal(nativeExchanges, 0);
});
test("a global logout invalidates a native login started in another Host even without its broadcast", async () => {
  const stores = setup();
  const callback = "https://auth.example.com/callback";
  const id = "fixture-native-state";
  let exchanges = 0;
  const adapter = {
    start: async () => ({
      id,
      authorizationUrl: `https://login.work.weixin.qq.com/wwlogin/sso/login?state=${id}`,
      callbackUrl: callback,
      expiresAt: 1500,
    }),
    complete: async () => {
      exchanges++;
      return session;
    },
    restore: async () => session,
  };
  const a = createEnterpriseIdentityService({
    credentials: stores.credentials,
    sessionStore: stores.a,
    adapter,
    now: () => 1000,
  });
  const b = createEnterpriseIdentityService({
    credentials: stores.credentials,
    sessionStore: stores.b,
    adapter,
    now: () => 1000,
  });
  await a.beginLogin();
  await b.logout();
  await a.completeLogin(id, `${callback}?code=fixture-code&state=${id}`);
  await a.completeLogin(id, `${callback}?code=fixture-code&state=${id}`);
  assert.equal(exchanges, 1, "CAS 拒绝后不能再次消费旧授权码");
  assert.equal((await a.getView()).status, "signed-out");
  assert.equal((await stores.a.read()).session, null);
});

test("real file-lock transaction preserves encrypted shared session and unrelated model keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-identity-shared-"));
  setDataBaseDir(dir);
  try {
    const credentials = createCredentialService();
    await credentials.save("fixture-model-key", "fixture-model-value");
    const transaction = <T>(operation: () => Promise<T>) =>
      withFileLock(join(dir, "identity-state"), operation);
    const a = createSharedIdentitySessionStore(credentials, transaction);
    const b = createSharedIdentitySessionStore(credentials, transaction);
    const results = await Promise.all([
      a.write(session, 0, () => true),
      b.write(session, 0, () => true),
    ]);
    assert.equal(results.filter((r) => r.accepted).length, 1);
    assert.equal((await b.read()).session?.token, session.token);
    assert.equal(await credentials.load("fixture-model-key"), "fixture-model-value");
    const raw = await readFile(join(dir, ".uwork/v2/credentials.json"), "utf8");
    assert.doesNotMatch(raw, /fixture-session|fixture-model-value/);
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
