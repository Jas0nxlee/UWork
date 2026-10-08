/**
 * 默认市场的来源声明：字符串形式给官方 CDN 用（`defaultMarketplaceSourceFromString` 解析），
 * 结构化形式给需要专属源类型的市场用；两者同时存在时结构化优先。
 */
export type DefaultPluginMarketplaceSourceConfig = {
  baseUrl: string;
  description?: string;
  name?: string;
  source: "skillhub";
};

export interface DefaultPluginMarketplace {
  id: string;
  source?: string;
  sourceConfig?: DefaultPluginMarketplaceSourceConfig;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";
/** 公司 AIHub（SkillHub）技能市场：UCAS 内部技能来源，契约见 specs/aihub-skill-source.md。 */
export const UWORK_AIHUB_PLUGIN_MARKETPLACE_ID = "ucas-aihub";
export const UWORK_AIHUB_SKILLHUB_BASE_URL = "https://aihub.ucas.com.cn/skillhub";

/** Settings 三类资源发现共用；Bootstrap 单测与官方 definition 的 defaultEnabled 机械对照。 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "image-search@zcode-plugins-official",
  "documents@zcode-plugins-official",
  "pdf@zcode-plugins-official",
  "presentations@zcode-plugins-official",
  "spreadsheets@zcode-plugins-official",
  // node_repl 宿主：不进市场、不对用户露出，也不贡献任何 skill/command/subagent，但必须
  // 始终可用 —— node_repl 的注册门禁是「Browser Use 或 Computer Use 任一启用」，宿主自己
  // 不参与那个判断。Browser Use 默认开着，宿主若默认关就等于它上来就没有宿主。
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "plugin-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
  // 电脑控制回退为默认关闭，故 computer-use 不在此名单内。
  // 该集合必须与 official-plugin-definitions.ts 里标了 defaultEnabled 的插件逐一对应，
  // bootstrap 的「Settings 默认启用集合与 CLI 的官方插件声明一致」单测机械对照两者。
]);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // ZCode 官方唯一市场：本地 seed 分片与 CDN 分片在 Agent storage 内合并。
    // CDN manifest 的 name 必须与该 canonical id 一致。
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official UWork plugins marketplace: built-in and community plugins for UWork.",
    pluginCount: 0,
  },
  {
    // 公司 AIHub 技能市场：客户端直接适配 SkillHub（发现 → 目录 → 按内容指纹校验 → 包装成插件）。
    // manifest.name 必须等于该 id —— 市场身份就是 manifest name，改名会让已有安装记录失联。
    id: UWORK_AIHUB_PLUGIN_MARKETPLACE_ID,
    sourceConfig: { baseUrl: UWORK_AIHUB_SKILLHUB_BASE_URL, source: "skillhub" },
    name: UWORK_AIHUB_PLUGIN_MARKETPLACE_ID,
    description: "Company AIHub skills from SkillHub: internal skills and toolkits for UCAS.",
    pluginCount: 0,
  },
];

// 商店分三段：公开 / 公司 / 个人。
// - 公开：ZCode 官方市场，保留 Featured 策展语义；
// - 公司：内部 AIHub 技能市场（SkillHub），来源受控、独立成段，不混进公开列表；
// - 个人：用户自己添加的市场源。
export const PUBLIC_STORE_MARKETPLACE_IDS = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;
export const COMPANY_STORE_MARKETPLACE_IDS = [UWORK_AIHUB_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}

export function isCompanyStoreMarketplaceId(id: string): boolean {
  return (COMPANY_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}

/** 受控来源（公开 ∪ 公司）：随包内置、不可删除，并参与商店目录自动刷新。 */
export function isCuratedStoreMarketplaceId(id: string): boolean {
  return isPublicStoreMarketplaceId(id) || isCompanyStoreMarketplaceId(id);
}
