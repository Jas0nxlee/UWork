#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./public-windows-ripgrep-source.mjs";

export const BINSKIM_PIN = Object.freeze({
  version: "4.4.9.13",
  url: "https://api.nuget.org/v3-flatcontainer/microsoft.codeanalysis.binskim/4.4.9.13/microsoft.codeanalysis.binskim.4.4.9.13.nupkg",
  sha512:
    "TTnXjE4qrAyDKHtbsOpVaGEXpIAzPO1G/G4l5So6Ie2RmpRFl3yjEYE4XDh6DeibG4rv+xFCtKdweyOjMN0XyA==",
});
export function assertBinskimSarif(sarif) {
  if (!Array.isArray(sarif.runs) || sarif.runs.length === 0)
    throw new Error("BinSkim produced no analysis run");
  let hasBinary = false;
  for (const run of sarif.runs) {
    if (!Array.isArray(run.results)) throw new Error("BinSkim result set is missing");
    hasBinary ||= (run.artifacts ?? []).some((artifact) =>
      /(?:^|[/\\])rg\.exe$/iu.test(artifact.location?.uri ?? ""),
    );
    for (const invocation of run.invocations ?? []) {
      if (invocation.executionSuccessful === false)
        throw new Error("BinSkim did not execute successfully");
      if (
        (invocation.toolExecutionNotifications ?? []).some(
          (entry) => entry.level === "error" || entry.level === "warning",
        )
      )
        throw new Error("BinSkim reported execution diagnostics");
    }
    const blocked = run.results.filter(
      (entry) =>
        entry.kind === "review" ||
        ((entry.kind === "fail" || entry.kind === undefined) &&
          (entry.level === "error" || entry.level === "warning" || entry.level === undefined)),
    );
    if (blocked.length)
      throw new Error(
        `BinSkim unresolved results: ${blocked.map((entry) => entry.ruleId).join(", ")}`,
      );
  }
  if (!hasBinary) throw new Error("BinSkim did not record the candidate executable");
}
function option(name) {
  const p = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(p));
  if (inline) return inline.slice(p.length);
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
export async function runPublicWindowsBinskim({ binary, workDir, outputDir, arch }) {
  if (process.platform !== "win32" || process.arch !== arch)
    throw new Error("BinSkim job must use the candidate's native Windows runner");
  const work = resolve(workDir);
  const output = resolve(outputDir);
  await mkdir(work, { recursive: true });
  await mkdir(output, { recursive: true });
  const response = await fetch(BINSKIM_PIN.url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`BinSkim download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha512").update(bytes).digest("base64") !== BINSKIM_PIN.sha512)
    throw new Error("BinSkim package hash mismatch");
  const archive = join(work, "binskim.zip");
  await writeFile(archive, bytes);
  await execute("tar", ["-xf", archive, "-C", work]);
  const candidates = (await files(work)).filter((file) => /[/\\]binskim\.exe$/iu.test(file));
  const executable =
    candidates.find((file) => file.includes(`win-${arch}`)) ??
    (arch === "arm64" ? candidates.find((file) => file.includes("win-x64")) : undefined);
  if (!executable) throw new Error("Pinned BinSkim package has no supported Windows executable");
  const evidence = {
    ...BINSKIM_PIN,
    packageSha256: createHash("sha256").update(bytes).digest("hex"),
    analyzerExecutable: executable,
    candidateNativeArch: arch,
    analyzerArch: executable.includes("win-arm64") ? "arm64" : "x64",
  };
  await writeFile(join(output, "binskim-tool.json"), JSON.stringify(evidence, null, 2) + "\n");
  const sarif = join(output, "binskim.sarif");
  await execute(
    executable,
    [
      "analyze",
      resolve(binary),
      "--output",
      sarif,
      "--rich-return-code",
      "true",
      "--environment",
      "false",
    ],
    { capture: true, logPath: join(output, "binskim.log") },
  );
  assertBinskimSarif(JSON.parse(await readFile(sarif, "utf8")));
  console.log("PASS complete BinSkim analysis");
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runPublicWindowsBinskim({
    binary: option("binary"),
    workDir: option("work-dir"),
    outputDir: option("output-dir"),
    arch: option("arch") ?? process.arch,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
