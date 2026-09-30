import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolvePackagedDesktopExecutable } from "../../packages/desktop/scripts/packaged-desktop-executable.mjs";
import { resolveDesktopProductIdentity } from "../../packages/desktop/scripts/desktop-product-identity.mjs";
import {
  releaseTargets,
  stageReleaseAssets,
  validateReleaseAssets,
  validateDependencyAudit,
} from "../desktop-release.mjs";

const version = "3.14.4";
const sha = "a".repeat(40);
test("packaged Electron runtime uses the version pinned in the desktop manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../packages/desktop/package.json", import.meta.url), "utf8"),
  );
  const { default: config } = await import("../../packages/desktop/electron-builder.config.js");
  assert.equal(config.electronVersion, manifest.devDependencies.electron);
});
test("Linux startup validation uses the retained executable from the production identity", () => {
  const identity = resolveDesktopProductIdentity({
    ZCODE_ENV: "production",
    ZCODE_PREVIEW_IDENTITY: "0",
  });
  const executable = resolvePackagedDesktopExecutable("linux", "arm64", "/fixture/dist");
  assert.equal(basename(executable), identity.linuxExecutableName);
  assert.equal(dirname(executable), join("/fixture/dist", "linux-arm64-unpacked"));
});
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-release-"));
  try {
    for (const target of releaseTargets) {
      const [platform, arch] = target.split("-");
      const source = join(directory, `source-${target}`);
      await mkdir(source);
      const extensions =
        platform === "mac"
          ? [".dmg", ".zip"]
          : platform === "win"
            ? [".exe"]
            : [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"];
      for (const ext of extensions)
        await writeFile(
          join(source, `UWork-${version}-${target}${ext}`),
          `fixture-${target}-${ext}`,
        );
      await stageReleaseAssets({ source, destination: directory, platform, arch, version, sha });
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("a complete release has 13 installers from one version and commit", async () => {
  await fixture(async (directory) =>
    assert.equal((await validateReleaseAssets({ directory, version, sha })).length, 13),
  );
});
test("a mutated installer cannot be published", async () => {
  await fixture(async (directory) => {
    await writeFile(join(directory, `UWork-${version}-win-x64.exe`), "changed");
    await assert.rejects(validateReleaseAssets({ directory, version, sha }), /checksum mismatch/);
  });
});
test("a missing platform and a mixed source commit each block release", async () => {
  await fixture(async (directory) => {
    const file = join(directory, "uwork-mac-x64.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.sha = "b".repeat(40);
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(validateReleaseAssets({ directory, version, sha }), /identity mismatch/);
    await rm(file);
    await assert.rejects(validateReleaseAssets({ directory, version, sha }), { code: "ENOENT" });
  });
});
test("unsafe manifest filenames cannot escape the artifact directory", async () => {
  await fixture(async (directory) => {
    const file = join(directory, "uwork-win-x64.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.files[0].name = `../UWork-${version}-win-x64.exe`;
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(validateReleaseAssets({ directory, version, sha }), /asset name/);
  });
});

test("Linux distribution architecture aliases retain the correct target", async () => {
  const source = await mkdtemp(join(tmpdir(), "uwork-linux-names-"));
  try {
    for (const [arch, aliases] of [
      ["x64", ["x86_64", "amd64", "x86_64", "x64"]],
      ["arm64", ["aarch64", "arm64", "aarch64", "arm64"]],
    ]) {
      const input = join(source, arch),
        output = join(source, `${arch}-assets`);
      await mkdir(input);
      const extensions = [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"];
      for (let i = 0; i < extensions.length; i++)
        await writeFile(
          join(input, `UWork-${version}-linux-${aliases[i]}${extensions[i]}`),
          "fixture",
        );
      await stageReleaseAssets({
        source: input,
        destination: output,
        platform: "linux",
        arch,
        version,
        sha,
      });
      assert.equal(
        JSON.parse(await readFile(join(output, `uwork-linux-${arch}.json`))).files.length,
        4,
      );
    }
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
test("a complete audit with zero high and critical findings is required", () => {
  validateDependencyAudit({ metadata: { vulnerabilities: { high: 0, critical: 0 } } });
  for (const counts of [
    {},
    { high: 1, critical: 0 },
    { high: 0, critical: -1 },
    { high: "0", critical: 0 },
  ])
    assert.throws(
      () => validateDependencyAudit({ metadata: { vulnerabilities: counts } }),
      /audit/,
    );
});
