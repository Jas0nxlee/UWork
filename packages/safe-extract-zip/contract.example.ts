import type { ZipExtractor } from "./contract.js";

export async function extractOwnedArchive(
  extract: ZipExtractor,
  zipPath: string,
  directory: string,
): Promise<void> {
  await extract(zipPath, { dir: directory });
}
