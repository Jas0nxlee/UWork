import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  collectReviewedPublisherRuntimeMaterials,
  nativeRuntimeBindingMatches,
} from "../windows-ripgrep-runtime-materials.mjs";

const policy = JSON.parse(
  await readFile(new URL("../msvc-runtime-license-bindings.json", import.meta.url)),
);
const binding = policy.bindings[0];
const runtime = {
  visualStudioVersion: binding.visualStudioVersion,
  vcToolsVersion: binding.vcToolsVersion,
  windowsSdkVersion: binding.windowsSdkVersion,
};
const libraries = Object.entries(binding.spectreLibraries).map(([name, sha256]) => ({
  name,
  sha256,
}));
const save = async (file, bytes) => ({
  file,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

test("actual x64 fingerprint binds full publisher originals, extracted notices and reviewed policy", async () => {
  const result = await collectReviewedPublisherRuntimeMaterials(runtime, libraries, save);
  assert.equal(result.notices.length, 2);
  assert.equal(result.publisherOriginals.length, 2);
  assert.ok(result.policySnapshot.sha256);
  assert.ok(
    nativeRuntimeBindingMatches(runtime, result.notices, libraries, result.policy.bindings),
  );
});

test("another IDE or changed Spectre library cannot borrow the x64 material review", async () => {
  const result = await collectReviewedPublisherRuntimeMaterials(runtime, libraries, save);
  assert.equal(
    nativeRuntimeBindingMatches(
      { ...runtime, visualStudioVersion: "18.0" },
      result.notices,
      libraries,
      policy.bindings,
    ),
    false,
  );
  assert.equal(
    nativeRuntimeBindingMatches(
      runtime,
      result.notices,
      [{ ...libraries[0], sha256: "0".repeat(64) }, ...libraries.slice(1)],
      policy.bindings,
    ),
    false,
  );
  const unmatched = await collectReviewedPublisherRuntimeMaterials(
    { ...runtime, visualStudioVersion: "18.0" },
    libraries,
    save,
  );
  assert.deepEqual(unmatched.notices, []);
  assert.deepEqual(unmatched.publisherOriginals, []);
});

test("publisher snapshot tampering is rejected rather than refreshing its declared digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uwork-msvc-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "policy.json");
  const changed = structuredClone(policy);
  changed.publisherNotices[0].originalSha256 = "0".repeat(64);
  await writeFile(file, JSON.stringify(changed));
  await assert.rejects(
    collectReviewedPublisherRuntimeMaterials(runtime, libraries, save, { policyPath: file }),
    /original.*checksum/iu,
  );
});
