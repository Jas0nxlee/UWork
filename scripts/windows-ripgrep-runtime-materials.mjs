import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

/** 只有逐版本/逐库/逐原文的受审 binding 能关闭 CRT 范围，不能按文件数量放行。 */
export function nativeRuntimeBindingMatches(runtime, notices, libraries, bindings) {
  return bindings.some((binding) => {
    if (
      binding.visualStudioVersion !== runtime.visualStudioVersion ||
      binding.vcToolsVersion !== runtime.vcToolsVersion ||
      binding.windowsSdkVersion !== runtime.windowsSdkVersion
    )
      return false;
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
    if (!binding.spectreLibraries || Object.keys(binding.spectreLibraries).length !== 3)
      return false;
    return ["libcmt.lib", "libvcruntime.lib", "libcpmt.lib"].every((name) =>
      libraries.some(
        (library) => library.name === name && library.sha256 === binding.spectreLibraries[name],
      ),
    );
  });
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
  const policy = JSON.parse(
    await readFile(new URL("./msvc-runtime-license-bindings.json", import.meta.url)),
  );
  requireValue(
    policy.schemaVersion === 1 && Array.isArray(policy.bindings),
    "Invalid native runtime license binding policy",
  );
  const proven = nativeRuntimeBindingMatches(runtime, notices, libraries, policy.bindings);
  return {
    notices,
    libraries,
    unprovedScope: proven
      ? []
      : [
          "Actual MSVC/CRT/Spectre version/library hashes have no reviewed applicable publisher EULA + redistribution + static-link binding.",
        ],
  };
}
