import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const desktopManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "packages/desktop/package.json"), "utf8"),
);

// 加载完整打包配置，文件 IO 与清单写入保持真实；仅隔离 ASAR、签名和可选 Helper 等打包工具边界。
async function fixture(
  t,
  { enterpriseConfig = false, requireEnterpriseConfig = false, cua = false } = {},
) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "uwork-packaging-config-")));
  const desktop = resolve(root, "packages/desktop");
  const appOutDir = resolve(root, "output");
  const originalEnv = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await rm(root, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    ZCODE_TARGET_OS: "win32",
    ZCODE_TARGET_ARCH: "x64",
    ZCODE_ENV: "production",
    ZCODE_PREVIEW_IDENTITY: "0",
    ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT: "0",
    ZCODE_ENABLE_WINDOWS_SIGN: "0",
    UWORK_REQUIRE_ENTERPRISE_IDENTITY_CONFIG: requireEnterpriseConfig ? "1" : "0",
  });

  async function write(relativePath, content) {
    const path = resolve(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await write("package.json", JSON.stringify({ type: "module" }));
  await write("packages/desktop/package.json", JSON.stringify(desktopManifest));
  await copyFile(
    resolve(repositoryRoot, "packages/desktop/electron-builder.config.js"),
    resolve(desktop, "electron-builder.config.js"),
  );
  for (const file of ["target-platform.mjs", "desktop-product-identity.mjs"]) {
    await mkdir(resolve(desktop, "scripts"), { recursive: true });
    await copyFile(
      resolve(repositoryRoot, "packages/desktop/scripts", file),
      resolve(desktop, "scripts", file),
    );
  }

  const stubModules = {
    "scripts/spawn-command.mjs": `export const runCommand = () => {}; export const runCommandAndReadStdout = () => "";`,
    "scripts/builtin-provider-config.mjs": `export const loadBuiltinProviderConfig = async () => ({ environment: "production", sourcePath: "provider.json" });`,
    "scripts/third-party-notices.mjs": `export const noticesFileName = "THIRD-PARTY-NOTICES.md"; export const stageElectronNotices = async () => {};`,
    "scripts/native-search-tools-config.mjs": `export const resolveNativeSearchReleasePlan = () => ({ extraResourceToolIds: [] });`,
    "packages/desktop/scripts/build-metadata.mjs": `export const getBuildMetadata = () => ({ appVersion: "0.0.0" });`,
    "packages/desktop/scripts/runtime-dependency-closure.mjs": `export const collectRuntimeModuleClosureEntries = () => [];`,
    "packages/desktop/scripts/desktop-asar-runtime-modules.mjs": `export const DESKTOP_ASAR_RUNTIME_MODULES = [];`,
    "packages/desktop/scripts/node-pty-package-assets.mjs": `import { resolve } from "node:path"; export const resolvePackagedNodePtyPrebuildPath = ({ resourcesDir }) => resolve(resourcesDir, "node-pty.node"); export const restoreTargetNodePtyPrebuild = () => {};`,
    "packages/desktop/scripts/packaged-sourcemap-cleanup.mjs": `export const cleanupPackagedSourcemaps = async () => {};`,
    "packages/desktop/scripts/powershell-command.mjs": `export const createWindowsPowerShellSecurityArgs = () => [];`,
    "packages/desktop/scripts/sharp-package-assets.mjs": `export const isSharpRequiredByComputerUse = () => false; export const verifyStagedSharp = () => [];`,
    "packages/desktop/scripts/computer-use-producer.mjs": `export const isRealComputerUseProducerInstalled = () => ${JSON.stringify(cua)};`,
    "packages/desktop/scripts/koffi-package-assets.mjs": `export const verifyStagedKoffi = () => [];`,
    "packages/desktop/scripts/windows-cua-helper-assets.mjs": `
      import { writeFile } from "node:fs/promises";
      import { resolve } from "node:path";
      export const resolveElectronBuilderWindowsTarget = () => ({ os: "win32", arch: "x64", key: "win32-x64" });
      export const finalizePackagedWindowsCuaHelper = async ({ resourcesDir }) => {
        await writeFile(resolve(resourcesDir, "finalized-helper.txt"), "helper");
      };
    `,
    "packages/desktop/scripts/desktop-native-package-policy.mjs": `export const findDesktopNativePackageViolations = () => []; export const createDesktopNativePackagePrunePatterns = () => []; export const parseAsarListWithPackState = () => [];`,
    "packages/desktop/scripts/app-asar-repack.mjs": `export const replaceAppAsarFromStaging = () => {};`,
    "packages/desktop/scripts/patch-nsis-install-section.mjs": `export const patchNsisInstallSectionFile = async () => ({ changed: false }); export const restoreNsisInstallSectionFileSync = () => {};`,
    "node_modules/@electron/asar/package.json": JSON.stringify({ name: "@electron/asar" }),
    "node_modules/@zcode/zcode-cua/package.json": JSON.stringify({
      name: "@zcode/zcode-cua",
      type: "module",
      exports: { "./broker/helperConstants": "./helper.js" },
    }),
    "node_modules/@zcode/zcode-cua/helper.js": `export const HELPER_APP_NAME = "Fixture Helper.app";`,
    "output/resources/app.asar": "fixture asar",
    "output/resources/node-pty.node": "fixture native binary",
    "output/UWork.exe": "fixture executable",
  };
  for (const [path, content] of Object.entries(stubModules)) await write(path, content);
  if (enterpriseConfig)
    await write("packages/desktop/.release-config/enterprise-identity.json", "{}");

  return {
    desktop,
    appOutDir,
    load: () => import(pathToFileURL(resolve(desktop, "electron-builder.config.js")).href),
  };
}

test("packaging config loads when public enterprise identity is optional and absent", async (t) => {
  const { load } = await fixture(t);
  const { default: config } = await load();
  assert.equal(
    config.extraResources.some((entry) => entry.to === "config/enterprise-identity.json"),
    false,
  );
});

test("packaging config includes the staged public enterprise identity", async (t) => {
  const { desktop, load } = await fixture(t, {
    enterpriseConfig: true,
    requireEnterpriseConfig: true,
  });
  const { default: config } = await load();
  assert.deepEqual(
    config.extraResources.find((entry) => entry.to === "config/enterprise-identity.json"),
    {
      from: resolve(desktop, ".release-config/enterprise-identity.json"),
      to: "config/enterprise-identity.json",
    },
  );
});

test("packaging config rejects a missing mandatory public enterprise identity", async (t) => {
  const { load } = await fixture(t, { requireEnterpriseConfig: true });
  await assert.rejects(load, /Release requires staged public enterprise identity configuration/);
});

test("packaged Electron runtime follows the desktop manifest", async (t) => {
  const { load } = await fixture(t);
  const { default: config } = await load();
  assert.equal(config.electronVersion, desktopManifest.devDependencies.electron);
});

for (const cua of [false, true]) {
  test(`Windows ownership manifest includes final files with ${cua ? "real" : "placeholder"} CUA`, async (t) => {
    const { appOutDir, load } = await fixture(t, { cua });
    const { default: config } = await load();
    await config.afterPack({ electronPlatformName: "win32", arch: 1, appOutDir });
    const manifest = await readFile(resolve(appOutDir, ".zcode-install-manifest"), "utf8");
    const expected = ["UWork.exe", "resources\\app.asar", "resources\\node-pty.node"];
    if (cua) expected.push("resources\\finalized-helper.txt");
    assert.equal(manifest, `${expected.sort().join("\r\n")}\r\n`);
  });
}
