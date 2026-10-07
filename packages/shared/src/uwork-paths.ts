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
