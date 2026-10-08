/**
 * UWork 自己的用户级数据根目录名（`{dataBaseDir}/.uwork`）。
 *
 * 与上游 ZCode 的 `~/.zcode` 完全分离：首次启动即为空目录，不做迁移，
 * 避免两个产品互相覆盖设置、凭据与日志。项目工作区内的 `.zcode/` 约定
 * （AGENTS.md、config.json、agents/ 等）属于仓库内容，不在此范围内。
 */
export const UWORK_DATA_ROOT_DIR_NAME = ".uwork";

/** 数据根目录覆盖环境变量；优先于兼容保留的 `ZCODE_DATA_BASE_DIR`。 */
export const UWORK_DATA_BASE_DIR_ENV = "UWORK_DATA_BASE_DIR";

/** 兼容旧脚本/文档仍在使用的数据根覆盖变量，仅作回退。 */
export const LEGACY_DATA_BASE_DIR_ENV = "ZCODE_DATA_BASE_DIR";

/** Agent/CLI 的用户级存储根（CLI 读取该变量决定 cli/skills/plugins 等落点）。 */
export const UWORK_STORAGE_DIR_ENV = "ZCODE_STORAGE_DIR";

/** 上游 ZCode 的用户级存储根目录名；未下发 storage root 时作为回退。 */
const LEGACY_STORAGE_ROOT_DIR_NAME = ".zcode";

const CLI_DIR_NAME = "cli";
const CLI_CONFIG_FILE_NAME = "config.json";

export type StorageRootEnv = Record<string, string | undefined>;

/**
 * 用户级存储根的唯一解析口：Host 通过 `ZCODE_STORAGE_DIR` 下发产品数据根
 * （UWork 下是 `{dataBaseDir}/.uwork`），未设置时保持上游默认 `~/.zcode`。
 *
 * 所有用户级目录（`config.json`、db、log、debug/rollout、workflows）都必须经这里解析 ——
 * 各模块自行拼 `homedir()/.zcode` 会让产品数据写进上游命名空间，见
 * `specs/uwork-data-root-separation.md` 的验收与已知缺口。
 *
 * 刻意不引 `node:os`/`node:path`：本模块也会被渲染进程引用，保持零依赖。
 */
export function resolveUserStorageRoot(env: StorageRootEnv = process.env): string {
  const configured = env[UWORK_STORAGE_DIR_ENV]?.trim();
  if (configured && configured.length > 0) return stripTrailingSeparators(configured);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home && home.length > 0
    ? joinPath(home, LEGACY_STORAGE_ROOT_DIR_NAME)
    : LEGACY_STORAGE_ROOT_DIR_NAME;
}

/** 用户级 CLI 目录 `<storageRoot>/cli`；传入的已经是 `cli` 目录时原样返回。 */
export function resolveUserCliRoot(env: StorageRootEnv = process.env): string {
  const storageRoot = resolveUserStorageRoot(env);
  return lastSegment(storageRoot) === CLI_DIR_NAME
    ? storageRoot
    : joinPath(storageRoot, CLI_DIR_NAME);
}

/** 用户级 CLI 配置文件 `<storageRoot>/cli/config.json`（插件启用状态、MCP、技能开关等）。 */
export function resolveUserCliConfigPath(env: StorageRootEnv = process.env): string {
  return joinPath(resolveUserCliRoot(env), CLI_CONFIG_FILE_NAME);
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/u, "");
}

function joinPath(base: string, segment: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${stripTrailingSeparators(base)}${separator}${segment}`;
}

function lastSegment(value: string): string {
  return stripTrailingSeparators(value).split(/[\\/]/u).pop() ?? "";
}
