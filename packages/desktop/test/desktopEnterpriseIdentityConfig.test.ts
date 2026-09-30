import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { resolveBundledEnterpriseIdentityConfigFilePath } from "../src/main/desktopEnterpriseIdentityConfig.js";
import { hostInitLocalMessageSchema } from "@zcode/shared";

test("Main gives Host a packaged resource path and validates bootstrap propagation", () => {
  const path = resolveBundledEnterpriseIdentityConfigFilePath({
    isPackaged: true,
    resourcesPath: "/fixture/resources",
    appPath: "/fixture/app.asar",
  });
  assert.equal(path, join("/fixture/resources", "config", "enterprise-identity.json"));
  const parsed = hostInitLocalMessageSchema.parse({
    type: "init-local",
    zcodeBuiltinProviderConfigFilePath: "/fixture/provider.json",
    enterpriseIdentityBuiltinConfigFilePath: path,
  });
  assert.equal(parsed.enterpriseIdentityBuiltinConfigFilePath, path);
  assert.equal(
    resolveBundledEnterpriseIdentityConfigFilePath({
      isPackaged: false,
      resourcesPath: "/fixture/resources",
      appPath: "/fixture/desktop",
    }),
    join("/fixture/desktop", ".release-config", "enterprise-identity.json"),
  );
});
