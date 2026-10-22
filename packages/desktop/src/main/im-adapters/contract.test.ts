import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveImAttachment, sanitizeFileName } from "../imAttachmentFile.js";

const location = vi.hoisted(() => ({ downloads: "" }));
vi.mock("electron", () => ({ app: { getPath: () => location.downloads } }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("桌面 IM 文件端口", () => {
  it("清洗路径分隔符，避免把附件名当作文件路径", () => {
    expect(sanitizeFileName("../../report.txt")).not.toMatch(/[\\/]/);
    expect(sanitizeFileName("...")).toBe("attachment");
  });
  it("重复保存不会覆盖下载目录中的既有文件", async () => {
    location.downloads = await mkdtemp(join(tmpdir(), "uwork-im-contract-"));
    roots.push(location.downloads);
    const first = await saveImAttachment({ name: "report.txt", bytes: new Uint8Array([1]) });
    const second = await saveImAttachment({ name: "report.txt", bytes: new Uint8Array([2]) });
    expect(second.path).not.toBe(first.path);
    expect(new Uint8Array(await readFile(first.path))).toEqual(new Uint8Array([1]));
    expect(new Uint8Array(await readFile(second.path))).toEqual(new Uint8Array([2]));
  });
});
