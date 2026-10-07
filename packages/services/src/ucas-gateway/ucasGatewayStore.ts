import { readFile, rm } from "node:fs/promises";
import { ucasGatewayStateSchema, type UcasGatewayState } from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

/** 网关状态文件：跨 Host 用文件锁串行写，内容损坏时按「无状态」处理并由下次同步覆盖。 */
export interface UcasGatewayStore {
  read(): Promise<UcasGatewayState | null>;
  write(state: UcasGatewayState | null): Promise<void>;
}

export function createUcasGatewayStore(options: {
  readonly filePath: string;
  readonly onCorrupt?: (error: unknown) => void;
}): UcasGatewayStore {
  const read = async (): Promise<UcasGatewayState | null> => {
    let raw: string;
    try {
      raw = await readFile(options.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return ucasGatewayStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      options.onCorrupt?.(error);
      return null;
    }
  };
  return {
    read,
    write: (state) =>
      withFileLock(options.filePath, async () => {
        if (!state) {
          await rm(options.filePath, { force: true });
          return;
        }
        await atomicWritePrivateTextFile(options.filePath, JSON.stringify(state, null, 2));
      }),
  };
}
