import assert from "node:assert/strict";
import test from "node:test";
import type { EnterpriseIdentityAdapter } from "../src/enterprise-identity/contract.js";
import {
  disposeEnterpriseIdentityService,
  createEnterpriseIdentityService,
} from "../src/enterprise-identity/enterpriseIdentityService.js";

// 多组织的服务级边界：选择只是设备偏好，必须命中配置清单、可持久化，
// 且 beginLogin 用选中的组织去拼授权 URL（用户与资源边界仍由服务端判定）。
const callbackUrl = "https://auth.example.com/callback?uwork_nonce=attempt-1";
const authorizationUrl = `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=wx-nj&agentid=1000002&redirect_uri=${encodeURIComponent(callbackUrl)}&state=nj`;

function createAdapter(startedWith: Array<string | undefined>): EnterpriseIdentityAdapter {
  const resolve = (orgId?: string | null) =>
    orgId === "bj" || orgId === "nj"
      ? { id: orgId, label: orgId === "bj" ? "北京" : "南京" }
      : undefined;
  return {
    listOrganizations: () => [
      { id: "bj", label: "北京" },
      { id: "nj", label: "南京" },
    ],
    resolveOrganization: (orgId) => resolve(orgId) ?? resolve("bj"),
    start: async (_signal, orgId) => {
      startedWith.push(orgId);
      return {
        id: "attempt-1",
        authorizationUrl,
        callbackUrl,
        expectedState: "nj",
        expiresAt: 600000,
      };
    },
    restore: async () => null,
  };
}

function createSelectionStore(initial: string | null) {
  const writes: Array<string | null> = [];
  let value = initial;
  return {
    writes,
    set: (next: string | null) => {
      value = next;
    },
    store: {
      read: async () => value,
      write: async (orgId: string | null) => {
        writes.push(orgId);
        value = orgId;
      },
    },
  };
}

const credentials = {
  load: async () => null,
  save: async () => {},
  delete: async () => {},
};

test("selecting an organization persists the preference and rejects unlisted ones", async () => {
  const startedWith: Array<string | undefined> = [];
  const selection = createSelectionStore(null);
  const service = createEnterpriseIdentityService({
    credentials,
    adapter: createAdapter(startedWith),
    organizationStore: selection.store,
    now: () => 1000,
  });

  const initial = await service.getView();
  assert.deepEqual(initial.organizations, [
    { id: "bj", label: "北京" },
    { id: "nj", label: "南京" },
  ]);
  // 没有记忆时落到默认组织（适配器解析的结果），不是「猜一个」。
  assert.equal(initial.selectedOrgId, "bj");

  const selected = await service.selectOrganization("nj");
  assert.equal(selected.selectedOrgId, "nj");
  assert.deepEqual(selection.writes, ["nj"]);

  await assert.rejects(service.selectOrganization("ghost"), /企业身份组织不可用/u);

  // beginLogin 用选中的组织；清单外的值永远不会传到适配器。
  const attempt = await service.beginLogin();
  assert.equal(attempt.expectedState, "nj");
  assert.deepEqual(startedWith, ["nj"]);
});

test("a remembered organization outside the list falls back to the default", async () => {
  const startedWith: Array<string | undefined> = [];
  const selection = createSelectionStore("ghost");
  const service = createEnterpriseIdentityService({
    credentials,
    adapter: createAdapter(startedWith),
    organizationStore: selection.store,
    now: () => 1000,
  });
  assert.equal((await service.getView()).selectedOrgId, "bj");
  assert.deepEqual(selection.writes, []);
});

test("a remembered organization in the list is restored on the next start", async () => {
  const selection = createSelectionStore("nj");
  const service = createEnterpriseIdentityService({
    credentials,
    adapter: createAdapter([]),
    organizationStore: selection.store,
    now: () => 1000,
  });
  assert.equal((await service.getView()).selectedOrgId, "nj");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("failed preference writes preserve the displayed and next-login organization", async () => {
  const starts: Array<string | undefined> = [];
  let failWrite = true;
  const service = createEnterpriseIdentityService({
    credentials,
    adapter: createAdapter(starts),
    organizationStore: {
      read: async () => "bj",
      write: async () => {
        if (failWrite) throw new Error("disk unavailable");
      },
    },
    now: () => 1000,
  });
  await service.getView();
  await assert.rejects(service.selectOrganization("nj"), /disk unavailable/);
  assert.equal((await service.getView()).selectedOrgId, "bj");
  await service.beginLogin();
  assert.deepEqual(starts, ["bj"]);
  await service.cancelLogin("attempt-1");
  failWrite = false;
  assert.equal((await service.selectOrganization("nj")).selectedOrgId, "nj");
});

test("concurrent hydration waits for one preference read before starting", async () => {
  const read = deferred<string | null>();
  let reads = 0;
  const starts: Array<string | undefined> = [];
  const service = createEnterpriseIdentityService({
    credentials,
    adapter: createAdapter(starts),
    organizationStore: {
      read: () => {
        reads++;
        return read.promise;
      },
      write: async () => {},
    },
    now: () => 1000,
  });
  const first = service.getView();
  const restore = service.restoreSession();
  const second = service.getView();
  const login = service.beginLogin();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, []);
  assert.equal(reads, 1);
  read.resolve("nj");
  await Promise.all([first, restore, second, login]);
  assert.deepEqual(starts, ["nj"]);
  assert.equal((await service.getView()).status, "waiting");
});

test("an earlier rejected selection cannot roll back the next successful selection", async () => {
  const write = deferred<void>();
  let calls = 0;
  const service = createEnterpriseIdentityService({
    credentials,
    adapter: createAdapter([]),
    organizationStore: {
      read: async () => "bj",
      write: async () => {
        if (++calls === 1) await write.promise;
      },
    },
    now: () => 1000,
  });
  await service.getView();
  const first = service.selectOrganization("nj");
  const failure = assert.rejects(first, /write failed/);
  const second = service.selectOrganization("bj");
  write.reject(new Error("write failed"));
  await failure;
  assert.equal((await second).selectedOrgId, "bj");
  assert.equal((await service.getView()).selectedOrgId, "bj");
});

test("disposing during hydration does not publish a late restored selection", async () => {
  const read = deferred<string | null>();
  const service = createEnterpriseIdentityService({
    credentials,
    adapter: createAdapter([]),
    organizationStore: { read: () => read.promise, write: async () => {} },
    now: () => 1000,
  });
  const events: unknown[] = [];
  service.onDidChange((view) => events.push(view));
  const pending = service.getView();
  await disposeEnterpriseIdentityService(service);
  const afterDispose = events.length;
  read.resolve("nj");
  await pending;
  assert.equal(events.length, afterDispose);
  assert.equal((await service.getView()).status, "signed-out");
});
