import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

const selectionSchema = z
  .object({
    version: z.literal(1),
    orgId: z.string().trim().min(1).max(256),
  })
  .strict();

/**
 * 本机记住的登录组织（设备偏好，不参与授权判断）：跨 Host 用文件锁串行写，
 * 内容损坏按「未选择」处理，由下次登录回落到配置默认组织。
 */
export interface IdentityOrganizationStore {
  read(): Promise<string | null>;
  write(orgId: string | null): Promise<void>;
}

export function createIdentityOrganizationStore(options: {
  readonly filePath: string;
  readonly onCorrupt?: (error: unknown) => void;
}): IdentityOrganizationStore {
  const read = async (): Promise<string | null> => {
    let raw: string;
    try {
      raw = await readFile(options.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return selectionSchema.parse(JSON.parse(raw)).orgId;
    } catch (error) {
      options.onCorrupt?.(error);
      return null;
    }
  };
  return {
    read,
    write: (orgId) =>
      withFileLock(options.filePath, async () => {
        if (!orgId) {
          await rm(options.filePath, { force: true });
          return;
        }
        await atomicWritePrivateTextFile(
          options.filePath,
          `${JSON.stringify({ version: 1, orgId }, null, 2)}\n`,
        );
      }),
  };
}
