import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, requireValue } from "./windows-ripgrep-license-archive.mjs";
import { checkedPath } from "./windows-ripgrep-license-files.mjs";

const MICROSOFT_LICENSE_SHA256 = "dea9265341829002e2c23a7372393eb2ed6e26085fb623f38a4ba0af833f30a6";
export async function collectMicrosoftPatchNotice(build, artifactRoot, sourcePins, save) {
  requireValue(
    build.source?.patchSha256 === sourcePins.patchSha256,
    "Microsoft patch hash mismatch",
  );
  const record = build.source.patchLicense;
  const source = `https://raw.githubusercontent.com/microsoft/ripgrep-prebuilt/${sourcePins.microsoftProducer}/LICENSE`;
  requireValue(
    record?.source === source && record.sha256 === MICROSOFT_LICENSE_SHA256,
    "Missing exact Microsoft patch original notice binding",
  );
  const path = await checkedPath(artifactRoot, resolve(artifactRoot, record.file));
  const bytes = await readFile(path);
  requireValue(
    digest(bytes) === MICROSOFT_LICENSE_SHA256,
    "Microsoft patch original notice checksum mismatch",
  );
  return { source, ...(await save("microsoft-patch/LICENSE.txt", bytes)) };
}

function runtimeFingerprintMatches(runtime, libraries, binding) {
  if (
    binding.visualStudioVersion !== runtime.visualStudioVersion ||
    binding.vcToolsVersion !== runtime.vcToolsVersion ||
    binding.windowsSdkVersion !== runtime.windowsSdkVersion ||
    !binding.spectreLibraries ||
    Object.keys(binding.spectreLibraries).length !== 3
  )
    return false;
  return ["libcmt.lib", "libvcruntime.lib", "libcpmt.lib"].every((name) =>
    libraries.some(
      (library) => library.name === name && library.sha256 === binding.spectreLibraries[name],
    ),
  );
}

/** 只有逐版本/逐库/逐原文的受审 binding 能关闭 CRT 范围，不能按文件数量放行。 */
export function nativeRuntimeBindingMatches(runtime, notices, libraries, bindings) {
  return bindings.some((binding) => {
    if (!runtimeFingerprintMatches(runtime, libraries, binding)) return false;
    if (
      !binding.publisherReview?.eula ||
      !binding.publisherReview?.redistribution ||
      !binding.publisherReview?.staticLinkBasis
    )
      return false;
    if (!Array.isArray(binding.requiredNotices) || binding.requiredNotices.length < 2) return false;
    if (
      !binding.requiredNotices.every((required) =>
        notices.some(
          (notice) => notice.sha256 === required.sha256 && notice.source === required.source,
        ),
      )
    )
      return false;
    return true;
  });
}

export async function collectReviewedPublisherRuntimeMaterials(
  runtime,
  libraries,
  save,
  { policyPath = new URL("./msvc-runtime-license-bindings.json", import.meta.url) } = {},
) {
  const policyBytes = await readFile(policyPath);
  const policy = JSON.parse(policyBytes);
  requireValue(
    policy.schemaVersion === 1 &&
      Array.isArray(policy.bindings) &&
      Array.isArray(policy.publisherNotices),
    "Invalid native runtime license binding policy",
  );
  const policySnapshot = await save("native-runtime/reviewed-policy.json", policyBytes);
  // 先匹配实际编译器和库，防止另一架构借用公开原文关闭自己的未证明范围。
  const bindings = policy.bindings.filter((binding) =>
    runtimeFingerprintMatches(runtime, libraries, binding),
  );
  const required = bindings.flatMap((binding) => binding.requiredNotices ?? []);
  const notices = [];
  const publisherOriginals = [];
  const scriptsRoot = fileURLToPath(new URL("./", import.meta.url));
  for (const record of policy.publisherNotices) {
    if (!required.some((item) => item.source === record.source && item.sha256 === record.sha256))
      continue;
    requireValue(
      typeof record.source === "string" &&
        record.originalSource === record.source &&
        typeof record.extraction === "string" &&
        /^[0-9a-f]{64}$/u.test(record.sha256 ?? "") &&
        /^[0-9a-f]{64}$/u.test(record.originalSha256 ?? "") &&
        typeof record.file === "string" &&
        typeof record.originalFile === "string",
      "Invalid reviewed publisher original source/hash",
    );
    const original = await readFile(
      await checkedPath(scriptsRoot, resolve(scriptsRoot, record.originalFile)),
    );
    requireValue(
      digest(original) === record.originalSha256,
      "Publisher original notice checksum mismatch",
    );
    const extracted = await readFile(
      await checkedPath(scriptsRoot, resolve(scriptsRoot, record.file)),
    );
    requireValue(
      digest(extracted) === record.sha256,
      "Publisher extracted notice checksum mismatch",
    );
    notices.push({
      source: record.source,
      ...(await save(`native-runtime/publisher/${record.sha256}.txt`, extracted)),
    });
    const extension = record.originalFile.match(/\.[a-zA-Z0-9]+$/u)?.[0] ?? ".bin";
    publisherOriginals.push({
      source: record.originalSource,
      noticeSha256: record.sha256,
      extraction: record.extraction,
      ...(await save(`native-runtime/publisher/${record.originalSha256}${extension}`, original)),
    });
  }
  requireValue(
    required.every((item) =>
      notices.some((notice) => notice.source === item.source && notice.sha256 === item.sha256),
    ),
    "Missing required reviewed publisher original notice",
  );
  return { policy, policySnapshot, notices, publisherOriginals };
}

export async function collectNativeRuntimeMaterials(build, save) {
  const runtime = build.nativeRuntime ?? {};
  const notices = [];
  for (const record of runtime.notices ?? []) {
    requireValue(
      typeof record.source === "string" && /^[0-9a-f]{64}$/u.test(record.sha256 ?? ""),
      "Missing native runtime original source/hash",
    );
    const bytes = await readFile(record.path);
    requireValue(
      digest(bytes) === record.sha256,
      "Native runtime original notice checksum mismatch",
    );
    const extension = record.path.match(/\.[a-zA-Z0-9]+$/u)?.[0] ?? ".txt";
    notices.push({
      source: record.source,
      ...(await save(`native-runtime/${digest(bytes)}${extension}`, bytes)),
    });
  }
  const libraries = [];
  for (const record of runtime.spectreLibraries ?? []) {
    requireValue(runtime.vcToolsInstallDir, "Missing actual MSVC toolset root");
    const path = await checkedPath(runtime.vcToolsInstallDir, record.path);
    const bytes = await readFile(path);
    requireValue(digest(bytes) === record.sha256, "Actual Spectre library checksum mismatch");
    const name = path.split(/[\\/]/u).at(-1).toLowerCase();
    libraries.push({ name, sha256: record.sha256, bytes: bytes.length });
  }
  const reviewed = await collectReviewedPublisherRuntimeMaterials(runtime, libraries, save);
  notices.push(...reviewed.notices);
  const proven = nativeRuntimeBindingMatches(runtime, notices, libraries, reviewed.policy.bindings);
  return {
    notices,
    libraries,
    policySnapshot: reviewed.policySnapshot,
    publisherOriginals: reviewed.publisherOriginals,
    unprovedScope: proven
      ? []
      : [
          "Actual MSVC/CRT/Spectre version/library hashes have no reviewed applicable publisher EULA + redistribution + static-link binding.",
        ],
  };
}
