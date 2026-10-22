import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import { open as openZip, type Entry, type ZipFile } from "yauzl";

// 组件级增量更新（从 CDN 拉组件包再合并 release）已随在线自升级路径一并拆除；
// 这里只保留 releaseInstaller 复用归档的安全解包实现。

function safeRelativePath(pathValue: string): string {
  if (
    !pathValue ||
    pathValue.includes("\0") ||
    isAbsolute(pathValue) ||
    win32.isAbsolute(pathValue)
  ) {
    throw new Error(`Unsafe component path: ${pathValue}`);
  }
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".."))
    throw new Error(`Unsafe component path: ${pathValue}`);
  return normalized;
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  captureOutput = false,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(captureOutput ? stdout : "");
      else rejectPromise(new Error(`${command} failed (${code}): ${stderr}`));
    });
  });
}

function validateArchiveEntries(listing: string): void {
  for (const rawEntry of listing.split(/\r?\n/u)) {
    const entry = rawEntry.trim().replace(/\/$/u, "");
    if (!entry || entry === ".") continue;
    safeRelativePath(entry.replace(/^\.\//u, ""));
  }
}

function openZipFile(archivePath: string): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    openZip(
      archivePath,
      { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => (error ? rejectPromise(error) : resolvePromise(zip)),
    );
  });
}

function openZipEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) =>
      error ? rejectPromise(error) : resolvePromise(stream),
    );
  });
}

function isZipSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function extractZipSafely(archivePath: string, destination: string): Promise<void> {
  const zip = await openZipFile(archivePath);
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const relativePath = safeRelativePath(entry.fileName).replace(/\/$/u, "");
          if (!relativePath) {
            zip.readEntry();
            return;
          }
          if (seen.has(relativePath))
            throw new Error(`Component archive contains duplicate entry: ${relativePath}`);
          seen.add(relativePath);
          if (isZipSymlink(entry))
            throw new Error(`Component archive contains a symbolic link: ${relativePath}`);
          const outputPath = join(destination, ...relativePath.split("/"));
          if (entry.fileName.endsWith("/")) {
            await mkdir(outputPath, { recursive: true });
          } else {
            await mkdir(dirname(outputPath), { recursive: true });
            const input = await openZipEntry(zip, entry);
            await pipeline(input, createWriteStream(outputPath, { mode: 0o600 }));
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

export async function extractArchiveSafely(
  archivePath: string,
  destination: string,
): Promise<void> {
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (isZip) {
    // macOS/Windows 自带 bsdtar 能读取 ZIP，GNU tar 不能；Linux 上用 tar 解 ZIP 会直接报错，
    // 单测与 Linux 控制端安装 Windows 归档因此稳定失败。ZIP 改走同进程解析并保留路径/链接校验。
    await extractZipSafely(archivePath, destination);
    return;
  }
  const listing = await run("tar", ["-tzf", archivePath], destination, true);
  const verboseListing = await run("tar", ["-tvzf", archivePath], destination, true);
  if (verboseListing.split(/\r?\n/u).some((line) => /^[lh]/u.test(line))) {
    throw new Error(`Component archive contains a symbolic or hard link: ${archivePath}`);
  }
  validateArchiveEntries(listing);
  await run("tar", ["-xzf", archivePath, "-C", destination], destination);
}
