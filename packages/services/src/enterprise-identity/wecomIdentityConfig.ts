import { readFile } from "node:fs/promises";
import { createWeComIdentityAdapter } from "./wecomIdentityAdapter.js";
import type { EnterpriseIdentityAdapter } from "./contract.js";

/** 只读取本机公开应用标识与认证服务地址，文件中不接受企业微信 Secret。 */
export async function loadWeComIdentityAdapter(
  path: string,
  fetchImpl: typeof fetch,
): Promise<EnterpriseIdentityAdapter | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read enterprise identity configuration");
  }
  return createWeComIdentityAdapter(JSON.parse(raw), { fetchImpl });
}
