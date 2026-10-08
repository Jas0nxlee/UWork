import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { injectHoistedRuntimeModulesIntoAsar } from "../../packages/desktop/electron-builder.config.js";
import { collectRuntimeModuleClosureEntries } from "../../packages/desktop/scripts/runtime-dependency-closure.mjs";
import { DESKTOP_ASAR_RUNTIME_MODULES } from "../../packages/desktop/scripts/desktop-asar-runtime-modules.mjs";

const require = createRequire(import.meta.url);
const { createPackage, extractAll, listPackage } = require("@electron/asar");
const execFileAsync = promisify(execFile);
const cryptoRoots = ["@peculiar/asn1-schema", "@peculiar/asn1-x509"];

test("runtime dependency lookup retains the named package root over CJS type markers", async () => {
  const entries = collectRuntimeModuleClosureEntries(cryptoRoots, [resolve(".")]);
  const utils = entries.find((entry) => entry.moduleName === "@peculiar/utils");
  const manifest = JSON.parse(await readFile(utils.packageJsonPath, "utf8"));
  assert.equal(manifest.name, "@peculiar/utils");
  assert.ok(manifest.exports["./encoding"]);
});

test("afterPack supplies the ASN.1 runtime closure outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-asar-runtime-"));
  try {
    const input = join(root, "input");
    const resources = join(root, "app", "resources");
    await mkdir(input, { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(
      join(input, "package.json"),
      JSON.stringify({ name: "fixture", private: true }),
    );
    await writeFile(join(input, "fixture.node"), "fixture unpacked marker");
    const cryptoEntries = collectRuntimeModuleClosureEntries(cryptoRoots, [resolve(".")]);
    const cryptoNames = new Set(cryptoEntries.map((entry) => entry.moduleName));
    // 非被测链路仅模拟已在包内；保留真实 crypto 包，避免复制整个 telemetry 树拖慢测试。
    const legacyEntries = collectRuntimeModuleClosureEntries(
      DESKTOP_ASAR_RUNTIME_MODULES.filter((name) => !cryptoRoots.includes(name)),
      [resolve(".")],
    );
    for (const { moduleName } of legacyEntries) {
      if (cryptoNames.has(moduleName)) continue;
      const directory = join(input, "node_modules", moduleName);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: moduleName }));
    }
    // 模拟 electron-builder 只带入主包、遗漏 hoisted 的子依赖，复现 pvtsutils 缺包。
    for (const { moduleName, sourceModulePath } of cryptoEntries) {
      if (moduleName === "pvtsutils") continue;
      await cp(sourceModulePath, join(input, "node_modules", moduleName), {
        recursive: true,
        dereference: true,
      });
    }
    const archive = join(resources, "app.asar");
    await createPackage(input, archive);
    await injectHoistedRuntimeModulesIntoAsar({
      appOutDir: join(root, "app"),
      electronPlatformName: "linux",
    });
    const entries = listPackage(archive).map((entry) => entry.replaceAll("\\", "/"));
    assert.ok(entries.some((entry) => entry.startsWith("/node_modules/pvtsutils/")));
    const unpacked = join(root, "unpacked");
    await mkdir(unpacked);
    extractAll(archive, unpacked);
    const probe = join(unpacked, "probe.cjs");
    await writeFile(
      probe,
      `
      const {AsnConvert} = require('@peculiar/asn1-schema');
      const {BasicConstraints} = require('@peculiar/asn1-x509');
      const encoded = AsnConvert.serialize(new BasicConstraints({cA:true}));
      if (!AsnConvert.parse(encoded, BasicConstraints).cA) throw new Error('Invalid CA constraints');
      process.stdout.write('ASN.1 runtime loaded');
    `,
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: unpacked,
      env: { ...process.env, NODE_PATH: "" },
    });
    assert.equal(stdout, "ASN.1 runtime loaded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
