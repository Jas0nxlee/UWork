import { readFile } from "node:fs/promises";
import { wecomIdentityConfigSchema, type WeComIdentityConfig } from "@zcode/shared";
import { createWeComIdentityAdapter } from "./wecomIdentityAdapter.js";
import type { EnterpriseIdentityAdapter } from "./contract.js";

/** 本机覆盖优先；新设备缺少本机文件时使用发布包公开配置。 */
export async function loadWeComIdentityConfig(
  path: string,
  builtinPath?: string,
): Promise<WeComIdentityConfig | undefined> {
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
      return wecomIdentityConfigSchema.parse(JSON.parse(raw));
    } catch {
      // 无效显式覆盖不能静默换组织；错误也不能回显企业参数或文件内容。
      throw new Error("Invalid enterprise identity configuration");
    }
  }
  return undefined;
}

/** 身份适配器与网关客户端共用同一份已校验公开配置。 */
export async function loadWeComIdentityAdapter(
  path: string,
  fetchImpl: typeof fetch,
  builtinPath?: string,
): Promise<EnterpriseIdentityAdapter | undefined> {
  const config = await loadWeComIdentityConfig(path, builtinPath);
  return config ? createWeComIdentityAdapter(config, { fetchImpl }) : undefined;
}
