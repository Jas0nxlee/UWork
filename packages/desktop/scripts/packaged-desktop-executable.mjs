import { join } from "node:path";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";

/** 正式包校验共用打包身份；不能从显示品牌猜测兼容可执行文件名。 */
export function resolvePackagedDesktopExecutable(platform, arch, dist) {
  const identity = resolveDesktopProductIdentity({
    ZCODE_ENV: "production",
    ZCODE_PREVIEW_IDENTITY: "0",
  });
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unknown packaged architecture");
  if (platform === "mac")
    return join(
      dist,
      arch === "arm64" ? "mac-arm64" : "mac",
      `${identity.productName}.app/Contents/MacOS/${identity.productName}`,
    );
  if (platform === "win")
    return join(
      dist,
      arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
      `${identity.productName}.exe`,
    );
  if (platform === "linux")
    return join(
      dist,
      arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
      identity.linuxExecutableName,
    );
  throw new Error("Unknown packaged platform");
}
