import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTargets, stageReleaseAssets, validateReleaseAssets } from "../desktop-release.mjs";

const version = "3.14.4";
const sha = "a".repeat(40);
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
