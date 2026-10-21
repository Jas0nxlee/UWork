/**
 * 探一下"这份文件能不能写回"（主要针对远端工作区）。
 *
 * 为什么用"故意失败的写入"来探：RPC 层没有能力清单，老远端遇到未实现的方法会抛
 * `Method not found: <name>`。这里带一个**必然不匹配的 expectedRevision** 调一次 writeBinaryFile：
 * 新服务端在校验版本时就返回 `File revision mismatch`（**发生在任何写盘/备份之前**，见
 * `packages/services/src/file/fileService.ts` 的实现顺序），老服务端则抛 `Method not found`。
 * 两者可区分，而且探测本身不会改动文件。
 */
import type { IFileService } from "@zcode/services";

export async function probeWriteSupport(
  fileService: IFileService,
  path: string,
): Promise<{ supported: boolean; reason?: string }> {
  try {
    await fileService.writeBinaryFile({
      path,
      dataBase64: "",
      expectedRevision: { size: -1, mtimeMs: -1 },
      backup: "none",
    });
    // 理论上到不了这里（版本必然不匹配）；真到了说明服务端没做版本校验，也算支持写。
    return { supported: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Method not found/i.test(message)) {
      return { supported: false, reason: "服务端没有实现二进制写回（writeBinaryFile）" };
    }
    return { supported: true };
  }
}
