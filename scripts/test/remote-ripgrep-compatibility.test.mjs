import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRemoteRipgrepVersion,
  assertRemoteRipgrepResult,
  REMOTE_RIPGREP_EXTRA_CASES,
} from "../test-remote-ripgrep-compatibility.mjs";

test("remote upgrade requires actual fixed source and PCRE2/JIT identity", () => {
  const output =
    "ripgrep 14.1.1 (rev 4649aa9700)\nfeatures:+pcre2\nPCRE2 10.49 is available (JIT is available)\n";
  assert.doesNotThrow(() => assertRemoteRipgrepVersion(output, "x64"));
  assert.throws(() => assertRemoteRipgrepVersion(output.replace("10.49", "10.43"), "x64"));
  assert.throws(() => assertRemoteRipgrepVersion(output, "arm64"));
});

test("readable regex diagnostic can change, but failure semantics cannot", () => {
  const baseline = {
    code: 2,
    stdout: "",
    stderr: "regex parse error:\n [\n error: unclosed character class\n",
  };
  assert.doesNotThrow(() =>
    assertRemoteRipgrepResult(
      { ...baseline, stderr: "regex parse error:\n  [\nerror: unclosed character class\n" },
      baseline,
      "text",
    ),
  );
  assert.throws(() => assertRemoteRipgrepResult({ ...baseline, code: 0 }, baseline, "text"));
  assert.throws(() =>
    assertRemoteRipgrepResult({ ...baseline, stderr: "unknown argument" }, baseline, "text"),
  );
});

test("remote comparison retains JSON match offsets and current invocation flags", () => {
  const result = (start) => ({
    code: 0,
    stderr: "",
    stdout:
      [
        { type: "begin", data: { path: { text: "file.txt" } } },
        { type: "match", data: { path: { text: "file.txt" }, submatches: [{ start, end: 3 }] } },
        { type: "end", data: { path: { text: "file.txt" }, stats: { matches: 1 } } },
        { type: "summary", data: { stats: { matches: 1 } } },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
  });
  assert.throws(() => assertRemoteRipgrepResult(result(1), result(0), "json"));
  for (const flag of [
    "--hidden",
    "--no-ignore",
    "--glob",
    "--ignore-case",
    "--fixed-strings",
    "--context",
    "--files-with-matches",
  ])
    assert.ok(
      REMOTE_RIPGREP_EXTRA_CASES.some((entry) => entry.args.includes(flag)),
      flag,
    );
});
