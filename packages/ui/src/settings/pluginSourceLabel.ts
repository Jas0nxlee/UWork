import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";

/**
 * 市场身份是 manifest name（= marketplace id），不适合直接展示，这里给出品牌展示名。
 * 品牌名不本地化；未列出的市场仍回落到概览 name 或原始 id。
 */
const MARKETPLACE_DISPLAY_NAMES: Record<string, string> = {
  "ucas-aihub": "UCAS AIHub",
};

/**
 * 把 marketplace id 解析为对用户友好的展示名：
 * 优先用品牌展示名，其次用 marketplaces 概览里的 name，缺失时回落到原始 id。
 * 纯函数，便于在目录标题栏与已安装来源标签间复用同一套命名。
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
): string {
  const known = MARKETPLACE_DISPLAY_NAMES[marketplaceId];
  if (known) return known;
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}
