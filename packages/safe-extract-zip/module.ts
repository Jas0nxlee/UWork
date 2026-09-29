export const safeExtractZipModule = {
  id: "safe-extract-zip",
  requires: [],
  provides: ["safe-zip-extraction"],
  publicEntrypoints: ["contract.ts", "index.cjs"],
} as const;
