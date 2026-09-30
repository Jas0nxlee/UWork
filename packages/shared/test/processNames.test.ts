import assert from "node:assert/strict";
import test from "node:test";
import { matchesZCodeProcessRole } from "../src/process-names.js";

test("classifies current and legacy Host and Agent names without matching lookalikes", () => {
  for (const prefix of ["uwork", "zcode"]) {
    assert.equal(matchesZCodeProcessRole(`${prefix}-host-local`), "host");
    assert.equal(matchesZCodeProcessRole(`${prefix}-agent-codex`), "agent");
  }
  assert.equal(matchesZCodeProcessRole("uwork-hostile"), null);
  assert.equal(matchesZCodeProcessRole("uwork-agentic"), null);
  assert.equal(matchesZCodeProcessRole("Network Service"), null);
});
