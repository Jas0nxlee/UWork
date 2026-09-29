import assert from "node:assert/strict";
import test from "node:test";
import { enterpriseLoginSurfaceSchema, enterpriseLoginRequestSchema } from "@zcode/shared";
import {
  createEnterpriseEmbedUrl,
  createEnterpriseEmbedCss,
  fitEnterpriseSurfaceBounds,
} from "../src/main/enterpriseLoginSurface.js";

const callbackUrl = "https://auth.example.com/callback?uwork_nonce=fixture-id";
const surface = {
  bounds: { x: 60, y: 80, width: 288, height: 330 },
  appearance: {
    backgroundColor: "rgb(43, 43, 43)",
    foregroundColor: "oklch(87% 0.006 286)",
    fontFamily: 'Inter, "PingFang SC", sans-serif',
    fontSize: 14,
  },
};
const authorizationUrl =
  "https://login.work.weixin.qq.com/wwlogin/sso/login?" +
  new URLSearchParams({
    login_type: "CorpApp",
    appid: "wx-fixture",
    agentid: "1000001",
    state: "fixture-org",
    redirect_uri: callbackUrl,
  });

test("embedding preserves the exact successful modern authorization URL and callback encoding", () => {
  const request = enterpriseLoginRequestSchema.parse({
    id: "fixture-id",
    callbackUrl,
    authorizationUrl,
    expectedState: "fixture-org",
    expiresAt: 999999,
    surface,
  });
  const url = new URL(createEnterpriseEmbedUrl(request));
  assert.equal(url.href, authorizationUrl);
  assert.equal(url.origin, "https://login.work.weixin.qq.com");
  assert.equal(url.pathname, "/wwlogin/sso/login");
  assert.equal(url.searchParams.get("state"), "fixture-org");
  assert.equal(url.searchParams.get("redirect_uri"), callbackUrl);
  assert.equal(url.searchParams.get("appid"), "wx-fixture");
  assert.equal(url.searchParams.get("login_type"), "CorpApp");
});
test("surface rejects CSS injection, URLs, invalid geometry and extra fields", () => {
  assert.ok(enterpriseLoginSurfaceSchema.safeParse(surface).success);
  for (const patch of [
    { bounds: { ...surface.bounds, width: 0 } },
    { bounds: { ...surface.bounds, x: -1 } },
    {
      appearance: {
        ...surface.appearance,
        backgroundColor: "red; background:url(https://attacker.example)",
      },
    },
    { appearance: { ...surface.appearance, fontFamily: "sans-serif;display:none" } },
    { script: "fixture" },
  ])
    assert.equal(enterpriseLoginSurfaceSchema.safeParse({ ...surface, ...patch }).success, false);
});
test("native bounds account for zoom and are clipped to the owning content area", () => {
  assert.deepEqual(fitEnterpriseSurfaceBounds(surface.bounds, 1.25, [800, 600]), {
    x: 75,
    y: 100,
    width: 360,
    height: 413,
  });
  assert.deepEqual(
    fitEnterpriseSurfaceBounds({ x: 700, y: 500, width: 300, height: 300 }, 1, [800, 600]),
    { x: 700, y: 500, width: 100, height: 100 },
  );
});
test("theme CSS removes decoration but preserves scanner states and QR contrast", () => {
  const css = createEnterpriseEmbedCss(surface.appearance);
  assert.ok(css.includes(surface.appearance.backgroundColor));
  assert.ok(css.includes(surface.appearance.fontFamily));
  assert.match(css, /\.title/);
  assert.match(css, /qrcode/);
  assert.doesNotMatch(css, /\.status[^}]*display:\s*none/);
});
