// 桌面主进程的用户级路径解析：与设置服务、Agent 使用同一套基准。
//
// 基准目录优先级：`UWORK_DATA_BASE_DIR` > `ZCODE_DATA_BASE_DIR`（兼容） > `ZCODE_DESKTOP_HOME_DIR`（e2e/多实例隔离）
// > `HOME`/`USERPROFILE` > `homedir()`；产品数据根是 `<base>/.uwork`，见 specs/uwork-data-root-separation.md。
//
// 主进程里那些「启动早于设置服务」的读取（硬件加速、数据根覆盖、窗口设置、诊断导出）都必须走这里，
// 自己拼 `homedir()/.zcode` 会把 UWork 的运行状态写进上游命名空间。

import { homedir } from "node:os";
import { join } from "node:path";
import { UWORK_DATA_ROOT_DIR_NAME } from "@zcode/shared";

const DATA_BASE_DIR_ENVS = ["UWORK_DATA_BASE_DIR", "ZCODE_DATA_BASE_DIR"] as const;

export function resolveDesktopHomePath(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of DATA_BASE_DIR_ENVS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  const desktopHome = env.ZCODE_DESKTOP_HOME_DIR?.trim();
  if (desktopHome) return desktopHome;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home && home.length > 0 ? home : homedir();
}

/** 产品数据根 `<base>/.uwork`。 */
export function resolveDesktopDataRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDesktopHomePath(env), UWORK_DATA_ROOT_DIR_NAME);
}

/** Agent/CLI 用户级目录 `<dataRoot>/cli`（Agent 侧由 Host 下发 ZCODE_STORAGE_DIR 指向同一处）。 */
export function resolveDesktopCliDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDesktopDataRootDir(env), "cli");
}

/** 应用设置文件 `<dataRoot>/v2/setting.json`。 */
export function resolveDesktopSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDesktopDataRootDir(env), "v2", "setting.json");
}

/** UWork 自己的插件同步根 `<dataRoot>/plugins`（区别于 CLI 缓存 `<dataRoot>/cli/plugins`）。 */
export function resolveDesktopPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDesktopDataRootDir(env), "plugins");
}
