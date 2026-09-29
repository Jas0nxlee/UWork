import type { ICredentialService } from "./credential.js";

/** 身份凭据只供 Host 使用；通用 Renderer/Web 凭据 RPC 不能绕过身份服务读取或伪造会话。 */
export function createPublicCredentialService(owner: ICredentialService): ICredentialService {
  const isPrivate = (key: string) => key.trim().startsWith("enterprise-identity:");
  return {
    async load(key) {
      return isPrivate(key) ? null : owner.load(key);
    },
    async save(key, value) {
      if (isPrivate(key)) throw new Error("Enterprise credentials are Host-private");
      await owner.save(key, value);
    },
    async delete(key) {
      if (isPrivate(key)) throw new Error("Enterprise credentials are Host-private");
      await owner.delete(key);
    },
  };
}
