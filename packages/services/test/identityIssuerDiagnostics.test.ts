import assert from "node:assert/strict";
import test from "node:test";
import { createIdentityIssuerDiagnostics } from "../src/enterprise-identity/identityIssuerDiagnostics.js";

test("issuer rejection logs only allowlisted classification and status", () => {
  const events: unknown[] = [];
  const diagnostics = createIdentityIssuerDiagnostics((value) => events.push(value));
  diagnostics.http(400, { error: "invalid code fixture-sensitive-token fixture-person" });
  assert.deepEqual(events, [
    { reason: "http-rejected", status: 400, category: "authorization-code" },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /sensitive|person|invalid code/);
});
test("response validation reports fixed field paths without values", () => {
  const events: unknown[] = [];
  const diagnostics = createIdentityIssuerDiagnostics((value) => events.push(value));
  diagnostics.schema(["user.id", "user.org_id", "evil-secret-field"]);
  assert.deepEqual(events, [{ reason: "response-schema", fields: ["user.id", "user.org_id"] }]);
});
