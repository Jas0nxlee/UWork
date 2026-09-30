import { readFile } from "node:fs/promises";
import { createWeComIdentityAdapter } from "./wecomIdentityAdapter.js";
import type { EnterpriseIdentityAdapter } from "./contract.js";

/** 本机覆盖优先；新设备缺少本机文件时使用发布包公开配置，凭据仍由身份 owner 保存。 */
export async function loadWeComIdentityAdapter(
  path: string,
  fetchImpl: typeof fetch,
  builtinPath?: string,
): Promise<EnterpriseIdentityAdapter | undefined> {
  for (const source of [path, ...(builtinPath ? [builtinPath] : [])]) {
    let raw: string;
    try {
      raw = await readFile(source, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Unable to read enterprise identity configuration");
    }
    try {
      if (raw.length > 16384) throw new Error("oversized");
      return createWeComIdentityAdapter(JSON.parse(raw), { fetchImpl });
    } catch {
      // 无效显式覆盖不能静默换组织；错误也不能回显企业参数或文件内容。
      throw new Error("Invalid enterprise identity configuration");
    }
  }
  return undefined;
}
