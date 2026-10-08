import assert from "node:assert/strict";
import test from "node:test";
import type { EnterpriseIdentityAdapter } from "../src/enterprise-identity/contract.js";
import { createEnterpriseIdentityService } from "../src/enterprise-identity/enterpriseIdentityService.js";

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
