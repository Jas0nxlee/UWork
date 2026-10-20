import assert from "node:assert/strict";
import test from "node:test";
import type { EnterpriseIdentitySession } from "@zcode/shared";
import {
  createLocalIdentitySessionStore,
  createSharedIdentitySessionStore,
  type IdentitySessionRecord,
} from "../src/enterprise-identity/identitySessionStore.js";

const session: EnterpriseIdentitySession = {
  profile: {
    id: "fixture-user",
    tenantId: "fixture-org",
    provider: "wecom",
    displayName: "Fixture",
  },
  token: "fixture-session-token",
  expiresAt: 2000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(kind: "local" | "shared") {
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
  let activeTransactions = 0;
  const transaction = <T,>(operation: () => Promise<T>): Promise<T> => {
    const locked = async () => {
      activeTransactions++;
      try {
        return await operation();
      } finally {
        activeTransactions--;
      }
    };
    const result = queue.then(locked, locked);
    queue = result.catch(() => {});
    return result;
  };
  const a =
    kind === "shared"
      ? createSharedIdentitySessionStore(credentials, transaction)
      : createLocalIdentitySessionStore(credentials);
  const b = kind === "shared" ? createSharedIdentitySessionStore(credentials, transaction) : a;
  return { a, b, transactionActive: () => activeTransactions > 0 };
}

for (const kind of ["local", "shared"] as const) {
  test(`${kind} guard rejects logout/relogin even when principal and token are unchanged`, async () => {
    const { a, b } = setup(kind);
    const initial = await a.write(session, 0, () => true);
    await b.write(null, initial.record.revision, () => true);
    await b.write(session, undefined, () => true);
    let committed = false;

    const result = await a.withCurrentSession(initial.record, async () => {
      committed = true;
      return "committed";
    });

    assert.equal(result, undefined);
    assert.equal(committed, false);
    const current = await a.read();
    assert.equal(current.session?.token, session.token);
    assert.equal(current.session?.profile.id, session.profile.id);
    assert.equal(current.revision, initial.record.revision + 2);
  });

  test(`${kind} guard accepts token renewal at the same revision and principal`, async () => {
    const { a, b } = setup(kind);
    const initial = await a.write(session, 0, () => true);
    const renewed = await b.renew(
      { ...session, token: "fixture-renewed-token", expiresAt: 3000 },
      initial.record,
      () => true,
    );
    assert.equal(renewed.accepted, true);
    assert.equal(renewed.record.revision, initial.record.revision);

    const result = await a.withCurrentSession(initial.record, async () => "committed");

    assert.equal(result, "committed");
    assert.equal((await a.read()).session?.token, "fixture-renewed-token");
  });

  test(`${kind} guard checks provider, user and tenant even at the same revision`, async () => {
    const { a } = setup(kind);
    const initial = await a.write(session, 0, () => true);
    for (const [field, value] of [
      ["provider", "other-provider"],
      ["id", "other-user"],
      ["tenantId", "other-org"],
    ] as const) {
      const expected = {
        ...initial.record,
        session: { ...session, profile: { ...session.profile, [field]: value } },
      } as IdentitySessionRecord;
      let committed = false;
      const result = await a.withCurrentSession(expected, async () => {
        committed = true;
        return "committed";
      });
      assert.equal(result, undefined, field);
      assert.equal(committed, false, field);
    }
  });

  test(`${kind} guard supports an expected empty session and rejects it after login`, async () => {
    const { a } = setup(kind);
    const empty = await a.read();
    assert.equal(empty.session, null);
    assert.equal(await a.withCurrentSession(empty, async () => "empty-current"), "empty-current");
    await a.write(session, empty.revision, () => true);
    let committed = false;
    const result = await a.withCurrentSession(empty, async () => {
      committed = true;
      return "stale-empty";
    });
    assert.equal(result, undefined);
    assert.equal(committed, false);
  });
}

test("shared guard holds the cross-Host transaction until its commit completes before logout", async () => {
  const { a, b, transactionActive } = setup("shared");
  const initial = await a.write(session, 0, () => true);
  const entered = deferred<void>();
  const releaseCommit = deferred<void>();
  const order: string[] = [];
  const guarded = a.withCurrentSession(initial.record, async () => {
    order.push("commit-start");
    entered.resolve();
    await releaseCommit.promise;
    order.push("commit-end");
    return "committed";
  });
  await entered.promise;
  assert.equal(
    transactionActive(),
    true,
    "guard must retain the identity lock during its side effect",
  );
  const logout = b
    .write(null, undefined, () => true)
    .then((result) => {
      order.push("logout");
      return result;
    });
  releaseCommit.resolve();
  const [result, loggedOut] = await Promise.all([guarded, logout]);

  assert.equal(result, "committed");
  assert.equal(loggedOut.accepted, true);
  assert.deepEqual(order, ["commit-start", "commit-end", "logout"]);
  assert.equal((await a.read()).session, null);
});

test("shared logout admitted first prevents a later guarded commit", async () => {
  const { a, b } = setup("shared");
  const initial = await a.write(session, 0, () => true);
  const logout = b.write(null, undefined, () => true);
  let committed = false;
  const guarded = a.withCurrentSession(initial.record, async () => {
    committed = true;
    return "committed";
  });
  const [loggedOut, result] = await Promise.all([logout, guarded]);

  assert.equal(loggedOut.accepted, true);
  assert.equal(result, undefined);
  assert.equal(committed, false);
});
