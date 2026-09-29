const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");

function contained(root, value) {
  const relative = path.relative(root, value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function statOrMissing(value) {
  try {
    return await fs.lstat(value);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function entryPath(root, name) {
  if (
    typeof name !== "string" ||
    !name ||
    /[\\:]/.test(name) ||
    name.includes("\0") ||
    path.posix.isAbsolute(name) ||
    path.win32.isAbsolute(name)
  )
    throw new Error("Unsafe ZIP entry path");
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Unsafe ZIP entry component");
  const destination = path.resolve(root, ...parts);
  if (!contained(root, destination)) throw new Error("ZIP entry leaves extraction root");
  return destination;
}
async function ensureDirectory(root, directory, mode = 0o755) {
  if (!contained(root, directory)) throw new Error("ZIP directory leaves extraction root");
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat = await statOrMissing(current);
    if (!stat) {
      await fs.mkdir(current, { mode });
      stat = await fs.lstat(current);
    }
    // 旧实现只校验父目录 realpath，仍可经现有 file symlink 覆盖 root 外文件。
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("ZIP write parent is not a plain directory");
  }
}
async function validateLink(root, destination, target) {
  const partsOf = (value) => {
    if (
      !value ||
      /[\\:]/.test(value) ||
      value.includes("\0") ||
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value)
    )
      throw new Error("Unsafe ZIP symbolic link target");
    return value.split("/");
  };
  let pending = partsOf(target);
  let current = path.dirname(destination);
  let expansions = 0;
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === ".") continue;
    current = part === ".." ? path.dirname(current) : path.join(current, part);
    if (!contained(root, current)) throw new Error("ZIP symbolic link leaves extraction root");
    const stat = await statOrMissing(current);
    if (stat?.isSymbolicLink()) {
      // realpath 的 ENOENT 不能证明安全：外部 dangling 链接也会返回 ENOENT。
      // 逐分量展开链接后再解释 ..，与文件系统遍历语义一致，限制循环链。
      if (++expansions > 40) throw new Error("ZIP symbolic link cycle or excessive depth");
      pending = [...partsOf(await fs.readlink(current)), ...pending];
      current = path.dirname(current);
    }
  }
}
async function readLink(stream) {
  // yauzl 的 stored entry stream 在 EOF 标记 destroyed 但不发送 close；事件消费避免 async iterator 等待挂起。
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        const error = new Error("ZIP symbolic link target is too large");
        stream.destroy(error);
        reject(error);
      } else chunks.push(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

module.exports = async function extract(zipPath, options) {
  if (!options || typeof options.dir !== "string" || !path.isAbsolute(options.dir))
    throw new Error("Target directory is expected to be absolute");
  await fs.mkdir(options.dir, { recursive: true });
  const root = await fs.realpath(options.dir);
  const archive = await promisify(yauzl.open)(zipPath, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
    autoClose: false,
  });
  const openStream = promisify(archive.openReadStream.bind(archive));
  const links = [];
  const extractEntry = async (entry) => {
    if (entry.fileName.startsWith("__MACOSX/")) return;
    const destination = entryPath(root, entry.fileName);
    if (options.onEntry) await options.onEntry(entry, archive);
    const entryMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const kind = entryMode & 0o170000;
    const isLink = kind === 0o120000;
    const directory =
      kind === 0o040000 ||
      entry.fileName.endsWith("/") ||
      (entry.versionMadeBy >>> 8 === 0 && entry.externalFileAttributes === 16);
    if (kind && kind !== 0o100000 && kind !== 0o040000 && kind !== 0o120000)
      throw new Error("Unsupported ZIP file type");
    const fallback = Number.parseInt(
      directory ? options.defaultDirMode : options.defaultFileMode,
      10,
    );
    const mode = (entryMode || fallback || (directory ? 0o755 : 0o644)) & 0o777;
    await ensureDirectory(
      root,
      directory ? destination : path.dirname(destination),
      directory ? mode : 0o755,
    );
    if (directory) return;
    const existing = await statOrMissing(destination);
    if (existing && (!existing.isFile() || existing.nlink > 1))
      throw new Error("ZIP destination is a link or special file");
    if (isLink) {
      const input = await openStream(entry);
      const target = await readLink(input);
      await validateLink(root, destination, target);
      await fs.symlink(target, destination);
      links.push({ destination, target });
    } else {
      const file = await fs.open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0),
        mode,
      );
      let input;
      try {
        input = await openStream(entry);
        await pipeline(input, file.createWriteStream({ autoClose: true }));
      } finally {
        input?.destroy();
        await file.close();
      }
    }
  };
  try {
    await new Promise((resolve, reject) => {
      let failed = false;
      const fail = (error) => {
        failed = true;
        archive.close();
        reject(error);
      };
      archive.on("error", fail);
      archive.once("end", resolve);
      archive.on("entry", (entry) => {
        if (!failed)
          void extractEntry(entry).then(() => {
            if (!failed) archive.readEntry();
          }, fail);
      });
      archive.readEntry();
    });
    for (const link of links) await validateLink(root, link.destination, link.target);
  } finally {
    archive.close();
  }
};
