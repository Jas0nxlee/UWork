import assert from "node:assert/strict";
import test from "node:test";
import { enterpriseLoginPopupRequestSchema, readEnterpriseIdentityCallback } from "@zcode/shared";
import { classifyEnterpriseLoginNavigation } from "../src/main/enterpriseLoginNavigation.js";
const id = "fixture-random-state";
const callbackUrl = "https://auth.example.com:9443/callback";
const query = new URLSearchParams({
  login_type: "CorpApp",
  appid: "wx-fixture",
  agentid: "1000001",
  redirect_uri: callbackUrl,
  state: id,
});
const request = {
  id,
  callbackUrl,
  authorizationUrl: `https://login.work.weixin.qq.com/wwlogin/sso/login?${query}`,
  expiresAt: 2000,
};
test("popup request accepts only official login route and bound redirect/state", () => {
  assert.equal(enterpriseLoginPopupRequestSchema.safeParse(request).success, true);
  for (const patch of [
    { authorizationUrl: "https://attacker.example/login" },
    { callbackUrl: "https://attacker.example/callback" },
    { id: "wrong" },
  ])
    assert.equal(
      enterpriseLoginPopupRequestSchema.safeParse({ ...request, ...patch }).success,
      false,
    );
});
test("navigation exact-host policy blocks scheme, host suffix, port and arbitrary paths", () => {
  assert.equal(
    classifyEnterpriseLoginNavigation(request.authorizationUrl, request),
    "authorization",
  );
  assert.equal(
    classifyEnterpriseLoginNavigation(`${callbackUrl}?code=c&state=${id}`, request),
    "callback",
  );
  for (const url of [
    "https://open.work.weixin.qq.com.attacker.example",
    "file:///tmp/login",
    "https://open.work.weixin.qq.com:9443/login",
    "https://auth.example.com:9443/other",
    "https://auth.example.com/callback",
  ])
    assert.equal(classifyEnterpriseLoginNavigation(url, request), "blocked");
});
test("callback accepts a single bound code and rejects duplicate state, fragment and extra data", () => {
  assert.equal(readEnterpriseIdentityCallback(request, `${callbackUrl}?code=c&state=${id}`), "c");
  for (const url of [
    `${callbackUrl}?code=c&state=${id}&state=${id}`,
    `${callbackUrl}?code=c&state=${id}#fragment`,
    `${callbackUrl}?code=c&state=${id}&token=untrusted`,
    `${callbackUrl}?state=${id}`,
  ])
    assert.throws(() => readEnterpriseIdentityCallback(request, url));
});

test("organization state compatibility requires unique unpredictable callback nonce", () => {
  const callback = `${callbackUrl}?uwork_nonce=${id}`;
  const query = new URLSearchParams({
    login_type: "CorpApp",
    appid: "wx-fixture",
    agentid: "1000001",
    state: "fixture-org",
    redirect_uri: callback,
  });
  const compatible = {
    ...request,
    expectedState: "fixture-org",
    callbackUrl: callback,
    authorizationUrl: `https://login.work.weixin.qq.com/wwlogin/sso/login?${query}`,
  };
  assert.equal(enterpriseLoginPopupRequestSchema.safeParse(compatible).success, true);
  assert.equal(
    readEnterpriseIdentityCallback(compatible, `${callback}&code=c&state=fixture-org`),
    "c",
  );
  for (const url of [
    `${callbackUrl}?code=c&state=fixture-org`,
    `${callbackUrl}?uwork_nonce=wrong&code=c&state=fixture-org`,
    `${callback}&uwork_nonce=${id}&code=c&state=fixture-org`,
    `${callback}&code=c&state=wrong`,
    `${callback}&code=c&state=fixture-org&token=untrusted`,
  ])
    assert.throws(() => readEnterpriseIdentityCallback(compatible, url));
  assert.equal(
    enterpriseLoginPopupRequestSchema.safeParse({ ...compatible, id: "wrong" }).success,
    false,
  );
});
