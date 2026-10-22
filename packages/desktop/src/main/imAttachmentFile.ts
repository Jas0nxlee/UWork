import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { SaveImAttachmentRequest, SaveImAttachmentResult } from "@zcode/shared";

/**
 * 把 IM 附件落到本机（默认"下载"目录），返回绝对路径。
 *
 * 为什么必须由宿主来做：渲染层的 `<a download>` 在 Electron 里不会自己落到磁盘
 * （实测点"下载"什么都不发生），而写文件本来也是宿主的能力。
 * 落盘用 `wx` + 序号重命名：同名文件不覆盖，避免把用户已有的文件悄悄替换掉。
 */
export async function saveImAttachment(
  payload: SaveImAttachmentRequest,
): Promise<SaveImAttachmentResult> {
  if (!payload.bytes || payload.bytes.byteLength === 0) {
    throw new Error("attachment bytes are empty");
  }
  const dir = join(app.getPath("downloads"), "UWork");
  await mkdir(dir, { recursive: true });

  const safeName = sanitizeFileName(payload.name);
  const target = await resolveAvailablePath(dir, safeName);
  await writeFile(target, Buffer.from(payload.bytes), { flag: "wx" });
  return { path: target, name: safeName, sizeBytes: payload.bytes.byteLength };
}

/** 文件名清洗：去掉路径分隔符与控制字符，避免穿越或非法名。 */
export function sanitizeFileName(raw: string): string {
  const cleaned = (raw ?? "")
    .replaceAll("\0", "")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/^\.+/u, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "attachment";
}

/**
 * 找一个还不存在的路径：`name.ext` 被占用就退成 `name (1).ext`。
 * 上限 100 次后带随机后缀，避免死循环（同名文件不该把下载卡住）。
 */
async function resolveAvailablePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let index = 0; index < 100; index += 1) {
    const candidate = join(dir, index === 0 ? name : `${base} (${index})${ext}`);
    const exists = await access(candidate).then(
      () => true,
      () => false,
    );
    if (!exists) return candidate;
  }
  return join(dir, `${base}-${Date.now()}${ext}`);
}
