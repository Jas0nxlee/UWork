import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  stageEnterpriseIdentityConfig,
  verifyPackagedEnterpriseIdentityConfig,
} from "../desktop-enterprise-identity.js";

const config = {
  corpId: "ww-fixture-corp",
  agentId: "1000001",
  orgId: "fixture-org",
  apiBaseUrl: "https://auth.example.com",
  callbackUrl: "https://auth.example.com/callback",
};
test("release configuration is allowlisted and verified in packaged resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-release-config-"));
  try {
    const expected = join(dir, "stage.json");
    const resources = join(dir, "resources");
    await stageEnterpriseIdentityConfig(config, expected);
    await mkdir(join(resources, "config"), { recursive: true });
    const packaged = join(resources, "config", "enterprise-identity.json");
    await writeFile(packaged, await readFile(expected));
    await verifyPackagedEnterpriseIdentityConfig(resources, expected);
    await writeFile(packaged, JSON.stringify({ ...config, orgId: "wrong-org" }));
    await assert.rejects(verifyPackagedEnterpriseIdentityConfig(resources, expected), /mismatch/);
    for (const raw of [
      undefined,
      { ...config, token: "private" },
      { ...config, apiBaseUrl: "http://auth.example.com" },
    ]) {
      await assert.rejects(stageEnterpriseIdentityConfig(raw, expected), /Invalid/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
