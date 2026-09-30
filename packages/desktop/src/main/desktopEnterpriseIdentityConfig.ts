import { join } from "node:path";

/** Main 解析安装布局；Host 仅收到路径，不依赖 Electron 的资源目录。 */
export function resolveBundledEnterpriseIdentityConfigFilePath(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "config", "enterprise-identity.json")
    : join(options.appPath, ".release-config", "enterprise-identity.json");
}
