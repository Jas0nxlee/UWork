import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decompress = promisify(gunzip);

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function fields(text) {
  const result = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-zA-Z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/u.exec(line.trim());
    if (match) result[match[1]] = JSON.parse(match[2]);
  }
  return result;
}

export function parseCargoLock(text) {
  return text
    .split(/^\[\[package\]\]\s*$/mu)
    .slice(1)
    .map((block) => {
      const record = fields(block);
      requireValue(
        typeof record.name === "string" && typeof record.version === "string",
        "Invalid Cargo.lock package",
      );
      return record;
    });
}

export function archiveName(name) {
  requireValue(
    name && !name.includes("\\") && !name.startsWith("/") && !name.split("/").includes(".."),
    "Unsafe crate member path",
  );
  return name.replace(/^\.\//u, "");
}

function tarText(header, start, end) {
  return header.subarray(start, end).toString("utf8").split("\0", 1)[0];
}

function tarNumber(header, start, end) {
  const value = tarText(header, start, end).trim();
  requireValue(/^[0-7]+$/u.test(value), "Unsupported crate tar numeric field");
  return Number.parseInt(value, 8);
}

function paxFields(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    requireValue(space > offset, "Invalid crate PAX header");
    const length = Number(data.subarray(offset, space).toString("ascii"));
    requireValue(
      Number.isSafeInteger(length) && length > space - offset + 1 && offset + length <= data.length,
      "Invalid crate PAX length",
    );
    const entry = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equal = entry.indexOf("=");
    if (equal > 0) result[entry.slice(0, equal)] = entry.slice(equal + 1);
    offset += length;
  }
  return result;
}
/** 从已核验 checksum 的原始 crate 取字节；解压树的自报清单不能证明许可原文。 */

export async function readCrateArchive(bytes, expectedSha256) {
  requireValue(digest(bytes) === expectedSha256, "Cargo crate archive checksum mismatch");
  const tar = await decompress(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  let nextPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = tarNumber(header, 148, 156);
    const actual = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    requireValue(actual === expected, "Invalid crate tar header checksum");
    const size = tarNumber(header, 124, 136);
    requireValue(
      Number.isSafeInteger(size) && offset + 512 + size <= tar.length,
      "Truncated crate tar member",
    );
    const data = tar.subarray(offset + 512, offset + 512 + size);
    const type = tarText(header, 156, 157);
    const prefix = tarText(header, 345, 500);
    const original = `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`;
    if (type === "x") nextPath = paxFields(data).path ?? nextPath;
    else if (type === "L") nextPath = data.toString("utf8").split("\0", 1)[0].replace(/\n$/u, "");
    else {
      const name = archiveName(nextPath ?? original);
      nextPath = undefined;
      if (type === "0" || type === "") {
        requireValue(!files.has(name), "Duplicate crate tar member");
        files.set(name, Buffer.from(data));
      } else requireValue(type === "5", "Unsupported non-file crate tar member");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireValue(files.size > 0, "Empty crate archive");
  return files;
}
