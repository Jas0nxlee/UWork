import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectNativeWindowsRuntimeEvidence } from "../public-windows-ripgrep-native-runtime.mjs";

test("installed runtime evidence includes separate SDK UCRT and import library fingerprints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uwork-native-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vc = join(root, "vc");
  const sdk = join(root, "sdk");
  const spectre = join(vc, "lib/spectre/x64");
  await mkdir(spectre, { recursive: true });
  for (const name of ["libcmt.lib", "libvcruntime.lib", "libcpmt.lib"])
    await writeFile(join(spectre, name), `fixture-${name}`);
  for (const [folder, name] of [
    ["ucrt", "libucrt.lib"],
    ["um", "ntdll.lib"],
  ]) {
    const dir = join(sdk, "Lib/10.0.26100.0", folder, "x64");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), `fixture-${name}`);
  }
  await mkdir(join(sdk, "Licenses/10.0.26100.0"), { recursive: true });
  await writeFile(join(sdk, "Licenses/10.0.26100.0/license.rtf"), "fixture SDK terms");
  const env = {
    VCToolsInstallDir: vc,
    VCToolsVersion: "14.44.35207",
    LIB: spectre,
    WindowsSdkDir: sdk,
    WindowsSDKVersion: "10.0.26100.0\\",
  };
  const result = await collectNativeWindowsRuntimeEvidence(env, "x64");
  assert.equal(result.spectreLibraries.length, 3);
  assert.deepEqual(
    result.sdkLibraries.map((x) => x.component),
    ["windows-sdk-ucrt", "windows-sdk-import"],
  );
  assert.equal(result.sdkNotices.length, 1);
  assert.match(result.sdkNotices[0].source, /Microsoft-Windows-SDK\/10\.0\.26100\.0\//u);
  await assert.rejects(
    collectNativeWindowsRuntimeEvidence({ ...env, LIB: vc }, "x64"),
    /Spectre CRT directory must be first/u,
  );
  await assert.rejects(
    collectNativeWindowsRuntimeEvidence({ ...env, WindowsSDKVersion: "10.0.99999.0" }, "x64"),
    /ENOENT/u,
  );
});
