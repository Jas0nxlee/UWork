import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addMarketplace,
  describeMarketplacePlugin,
  ensureDefaultPluginMarketplaces,
  installMarketplacePlugin,
  loadKnownMarketplacesSync,
} from "../src/plugins/marketplace.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "uwork-trust-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("personal file/settings/SkillHub sources cannot claim company ID, including refresh rename", async () =>
  fixture(async (root) => {
    const storageRoot = join(root, "storage");
    ensureDefaultPluginMarketplaces(storageRoot);
    const before = loadKnownMarketplacesSync(storageRoot);
    await mkdir(join(root, "source"));
    const manifest = join(root, "source", "marketplace.json");
    await writeFile(manifest, JSON.stringify({ name: "ucas-aihub", plugins: [] }));
    for (const trustedId of [undefined, "personal", "ucas-aihub"]) {
      await assert.rejects(
        addMarketplace({ source: { source: "file", path: manifest }, storageRoot, trustedId }),
        /Reserved marketplace/,
      );
    }
    await assert.rejects(
      addMarketplace({
        source: { source: "skillhub", baseUrl: "https://personal.example", name: "ucas-aihub" },
        storageRoot,
      }),
      /Reserved marketplace/,
    );
    await writeFile(manifest, JSON.stringify({ name: "personal", plugins: [] }));
    await assert.rejects(
      addMarketplace({
        source: { source: "file", path: manifest },
        expectedId: "ucas-aihub",
        storageRoot,
      }),
      /id mismatch/,
    );
    assert.deepEqual(loadKnownMarketplacesSync(storageRoot), before);
  }));

test("preview and install reject traversal without changing an outside file or creating cache", async () =>
  fixture(async (root) => {
    const storageRoot = join(root, "storage");
    const outside = join(root, "outside");
    await writeFile(outside, "unchanged");
    await mkdir(join(root, "source"));
    const manifest = join(root, "source", "marketplace.json");
    await writeFile(
      manifest,
      JSON.stringify({
        name: "personal",
        plugins: [
          {
            name: "fixture",
            source: {
              source: "skillhub",
              baseUrl: "https://skills.example",
              slug: "../../outside",
              version: "1",
            },
          },
        ],
      }),
    );
    await addMarketplace({ source: { source: "file", path: manifest }, storageRoot });
    const before = await readdir(storageRoot);
    const preview = await describeMarketplacePlugin({
      marketplace: "personal",
      name: "fixture",
      storageRoot,
    });
    assert.ok(preview.diagnostics.some((item) => /slug/i.test(item.message)));
    await assert.rejects(
      installMarketplacePlugin({ marketplace: "personal", name: "fixture", storageRoot }),
      /slug/i,
    );
    assert.equal(await readFile(outside, "utf8"), "unchanged");
    assert.deepEqual(await readdir(storageRoot), before);
  }));
