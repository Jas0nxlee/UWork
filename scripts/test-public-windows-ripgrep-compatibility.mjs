#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSha256, sha256 } from "./public-windows-ripgrep-plan.mjs";
import { execute } from "./public-windows-ripgrep-source.mjs";
import { runRipgrepCompatibility } from "./public-ripgrep-compatibility.mjs";

function option(name) {
  const p = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(p));
  if (inline) return inline.slice(p.length);
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
async function main() {
  const arch = option("arch") ?? process.arch;
  assert.equal(process.platform, "win32", "Compatibility must execute on Windows");
  assert.equal(process.arch, arch, "Compatibility must execute on the native target architecture");
  const candidate = resolve(option("candidate"));
  const archive = resolve(option("baseline-archive"));
  const output = resolve(option("output-dir"));
  await mkdir(output, { recursive: true });
  const expectedArchive =
    arch === "arm64"
      ? "88660d96f822d2e0329e254031068e82028f9c13efcec9b2d78c5a19d3f9ac47"
      : "ede1d7f533f30d7e2870f77139d0fb9d7591daad5260b80d6a525e0bb5bd440e";
  assertSha256(await readFile(archive), expectedArchive, "Original compatibility baseline archive");
  const work = await mkdtemp(join(tmpdir(), "uwork-rg-compat-"));
  const baselineDir = join(work, "baseline");
  await mkdir(baselineDir);
  await execute("tar", ["-xf", archive, "-C", baselineDir]);
  const baseline = join(baselineDir, "rg.exe");
  assertSha256(
    await readFile(baseline),
    arch === "arm64"
      ? "6545d832a57164e54405f019cf6861c397920aa1d6cc4569bfd85441f79ea043"
      : "57aec5102a212204920d089562d9dbcaa438e9f2222d9a370d439622441b64f0",
    "Original compatibility baseline executable",
  );
  const results = await runRipgrepCompatibility({
    candidate,
    baseline,
    fixtureDir: join(work, "fixture"),
  });
  await writeFile(
    join(output, "compatibility.json"),
    JSON.stringify(
      {
        nativePlatform: process.platform,
        nativeArch: process.arch,
        candidateSha256: sha256(await readFile(candidate)),
        cases: results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`PASS ${results.length} real native compatibility cases (${arch})`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
