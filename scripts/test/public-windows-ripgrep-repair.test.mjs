import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  createPublicWindowsRipgrepPlan,
} from "../public-windows-ripgrep-plan.mjs";
import * as collector from "../collect-windows-ripgrep-license-materials.mjs";

test("collector accepts both named argument forms and preserves equals inside values", () => {
  const values = {
    "source-dir": "source=path",
    "cargo-home": "cargo",
    "rustup-home": "rustup",
    toolchain: "nightly-2025-06-26",
    target: "x86_64-pc-windows-msvc",
    "output-dir": "output",
    "build-manifest": "build.json",
  };
  const inline = Object.entries(values).map(([name, value]) => `--${name}=${value}`);
  const separate = Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]);
  assert.deepEqual(collector.cliOptions(inline), collector.cliOptions(separate));
  assert.equal(collector.cliOptions(inline).sourceDir, "source=path");
  for (const args of [
    [...inline, "--source-dir", "again"],
    [...inline, "--source-dir=again"],
    inline.map((arg) => (arg.startsWith("--source-dir=") ? "--source-dir=" : arg)),
    separate.filter((arg) => arg !== "source=path"),
    [...inline, "--unknown=value"],
  ])
    assert.throws(() => collector.cliOptions(args));
});

test("the native plan enables real stack protection across std and crates and records link args", () => {
  for (const arch of ["x64", "arm64"]) {
    const plan = createPublicWindowsRipgrepPlan({
      arch,
      hostPlatform: "win32",
      hostArch: arch,
      env: {},
    });
    assert.ok(plan.rustFlags.includes("-Zstack-protector=all"));
    assert.ok(plan.rustFlags.includes("--print=link-args"));
    assert.match(plan.cflags, /(?:^| )\/GS(?: |$)/u);
  }
});

test("official PCRE2 regression requires all standard Windows tests and rejects skips or failures", async () => {
  const { assertPcre2StandardTests } =
    await import("../public-windows-ripgrep-pcre2-regression.mjs");
  const names = ["pcre2_test_bat", "pcre2_grep_test_bat", "pcre2_jit_test", "pcre2posix_test"];
  const xml = (entries) =>
    `<testsuite tests="${entries.length}" failures="0" skipped="0">${entries.map((name) => `<testcase name="${name}"><system-out>official regression</system-out></testcase>`).join("")}</testsuite>`;
  assert.deepEqual(assertPcre2StandardTests(names, xml(names)), names);
  for (const [listed, junit] of [
    [names.slice(1), xml(names)],
    [names, xml(names.slice(1))],
    [names, xml(names).replace('failures="0"', 'failures="1"')],
    [names, xml(names).replace('skipped="0"', 'skipped="1"')],
    [names, xml(names).replace("<system-out>", "<failure>error</failure><system-out>")],
    [[...names, "extra"], xml(names)],
  ])
    assert.throws(() => assertPcre2StandardTests(listed, junit));
});

const event = (type, path, extra = {}) => ({ type, data: { path: { text: path }, ...extra } });
const block = (path) => [
  event("begin", path),
  event("match", path, {
    lines: { text: "中文 result\n" },
    line_number: 2,
    absolute_offset: 7,
    submatches: [{ match: { text: "中文" }, start: 0, end: 6 }],
  }),
  event("end", path, { stats: { matches: 1, bytes_searched: 21, elapsed: { secs: 0, nanos: 1 } } }),
];
const summary = {
  type: "summary",
  data: { stats: { matches: 2, bytes_searched: 42 }, elapsed_total: { secs: 0 } },
};
const result = (events) => ({
  code: 0,
  stderr: "",
  stdout: events.map(JSON.stringify).join("\n") + "\n",
});

test("JSON comparison permits independent file block order and retains lifecycle, offsets and stats", async () => {
  const { normalizeCompatibilityResult: normalize } =
    await import("../public-ripgrep-compatibility.mjs");
  const first = result([...block("crlf.txt"), ...block("中文🙂.ts"), summary]);
  const reordered = result([...block("中文🙂.ts"), ...block("crlf.txt"), summary]);
  assert.deepEqual(normalize(first, "json"), normalize(reordered, "json"));
  for (const change of [
    (events) => {
      events[1].data.absolute_offset += 1;
    },
    (events) => {
      events[1].data.submatches[0].end += 1;
    },
    (events) => {
      events[2].data.stats.bytes_searched += 1;
    },
    (events) => {
      events.at(-1).data.stats.matches -= 1;
    },
  ]) {
    const events = [...block("crlf.txt"), ...block("中文🙂.ts"), structuredClone(summary)];
    change(events);
    assert.notDeepEqual(normalize(first, "json"), normalize(result(events), "json"));
  }
  for (const events of [
    [block("x")[1], ...block("x"), summary],
    [...block("x"), event("match", "x"), summary],
    [...block("x"), ...block("x"), summary],
    [event("begin", "x"), summary],
    [...block("x")],
  ])
    assert.throws(() => normalize(result(events), "json"));
});

test("build provenance requires fresh std and panic artifacts and their actual final link inputs", async () => {
  const { readBuildProvenance } = await import("../public-windows-ripgrep-build-evidence.mjs");
  const root = "C:\\build\\target\\x86_64-pc-windows-msvc\\release";
  const artifact = (name) => ({
    reason: "compiler-artifact",
    target: { name },
    fresh: false,
    filenames: [name === "rg" ? `${root}\\rg.exe` : `${root}\\deps\\lib${name}-abc.rlib`],
  });
  const messages = [artifact("std"), artifact("panic_unwind"), artifact("rg")];
  const flags = `-Ccontrol-flow-guard=yes -Zstack-protector=all --remap-path-prefix=C:\\rust=/rustc/${pins.rustCommit}`;
  const commands = [
    `Running rustc.exe --crate-name std ${flags}`,
    `Running rustc.exe --crate-name rg ${flags}`,
    `"C:\\\\VS\\\\link.exe" "/OUT:C:\\\\build\\\\target\\\\x86_64-pc-windows-msvc\\\\release\\\\deps\\\\rg.exe" "${messages[0].filenames[0].replaceAll("\\", "\\\\")}" "${messages[1].filenames[0].replaceAll("\\", "\\\\")}"`,
  ];
  const log = [...messages.map(JSON.stringify), ...commands].join("\n");
  const evidence = readBuildProvenance(log);
  assert.deepEqual(evidence.stdArtifact, messages[0]);
  assert.equal(evidence.linkCommand, commands[2]);
  for (const bad of [
    log.replace('"fresh":false', '"fresh":true'),
    log.replaceAll("libstd-abc.rlib", "precompiled-std.rlib"),
    [...messages.map(JSON.stringify), ...commands.slice(0, 2)].join("\n"),
    log.replaceAll("-Zstack-protector=all", ""),
    log.replaceAll(pins.rustCommit, "0".repeat(40)),
  ])
    assert.throws(() => readBuildProvenance(bad));
});

test("installed compiler component files must byte-match the hash-verified official archive", async () => {
  const { assertCompilerComponentFile } =
    await import("../public-windows-ripgrep-build-evidence.mjs");
  const bytes = Buffer.from("compiler fixture");
  assert.match(
    assertCompilerComponentFile(bytes, Buffer.from(bytes), "bin/rustc.exe"),
    /^[a-f0-9]{64}$/u,
  );
  assert.throws(
    () => assertCompilerComponentFile(bytes, Buffer.from("different"), "bin/rustc_driver.dll"),
    /official component/u,
  );
});

function pdbFixture() {
  const bytes = Buffer.alloc(5 * 512);
  bytes.write("Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0", 0, "binary");
  bytes.writeUInt32LE(512, 32);
  bytes.writeUInt32LE(5, 40);
  bytes.writeUInt32LE(16, 44);
  bytes.writeUInt32LE(1, 52);
  bytes.writeUInt32LE(2, 512); // directory block
  bytes.writeUInt32LE(2, 1024);
  bytes.writeUInt32LE(0, 1028);
  bytes.writeUInt32LE(28, 1032);
  bytes.writeUInt32LE(3, 1036); // info stream block
  bytes.writeUInt32LE(20000404, 1536);
  bytes.writeUInt32LE(1, 1544);
  Buffer.alloc(16, 7).copy(bytes, 1548);
  return bytes;
}
function peFixture() {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ");
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write("PE\0\0", 128);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(0x20b, 152);
  bytes.writeUInt32LE(0x1000, 312);
  bytes.writeUInt32LE(28, 316); // debug directory
  bytes.writeUInt32LE(512, 400);
  bytes.writeUInt32LE(0x1000, 404);
  bytes.writeUInt32LE(512, 408);
  bytes.writeUInt32LE(512, 412);
  bytes.writeUInt32LE(2, 524);
  bytes.writeUInt32LE(31, 528);
  bytes.writeUInt32LE(560, 536);
  bytes.write("RSDS", 560);
  Buffer.alloc(16, 7).copy(bytes, 564);
  bytes.writeUInt32LE(1, 580);
  bytes.write("rg.pdb\0", 584);
  return bytes;
}
test("PE CodeView and real PDB stream identity must match without synthetic version markers", async () => {
  const { assertPePdbBinding } = await import("../public-windows-ripgrep-build-evidence.mjs");
  const binary = peFixture();
  const pdb = pdbFixture();
  const binding = assertPePdbBinding(binary, pdb);
  assert.equal(binding.guid, "07".repeat(16));
  assert.equal(binding.age, 1);
  assert.equal(binding.executableCommitStringPresent, false);
  assert.equal(binding.pdbCommitStringPresent, false);
  const wrong = Buffer.from(pdb);
  wrong[1548] = 8;
  assert.throws(() => assertPePdbBinding(binary, wrong), /PDB/u);
  assert.throws(() => assertPePdbBinding(binary, pdb.subarray(0, 520)));
});
