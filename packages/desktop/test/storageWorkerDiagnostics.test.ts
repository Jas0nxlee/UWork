import assert from "node:assert/strict";
import test from "node:test";
import { classifyStorageWorkerStderr } from "../src/host/storageWorkerDiagnostics.js";

test("worker stderr diagnostics expose only fixed hints without paths, tokens or user data", () => {
  const hints = classifyStorageWorkerStderr(
    "Error: process.chdir() is not supported in workers; fixture-private-token https://auth.example.com /fixture/person",
  );
  assert.deepEqual(hints, ["worker-api"]);
  assert.doesNotMatch(JSON.stringify(hints), /fixture|https|person|process/);
  assert.deepEqual(classifyStorageWorkerStderr("fixture-private-token"), []);
  assert.deepEqual(classifyStorageWorkerStderr("--cwd path is not accessible: /fixture/测试用户"), [
    "cwd-inaccessible",
  ]);
});
