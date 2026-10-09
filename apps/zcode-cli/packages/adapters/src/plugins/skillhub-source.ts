// SkillHub（公司 AIHub 技能平台）作为**市场来源**的适配：发现 API 基址 → 翻页取目录 →
// 归一化成 marketplace manifest（交给 marketplace.ts 的 normalizeMarketplaceManifest）。
//
// 安装侧（取指纹、下载、校验、包装成插件）见 skillhub-package.ts。

import { createHash } from "node:crypto";
import type { HttpClientPort } from "@zcode/contracts";
import {
  isRecord,
  normalizeSkillhubBaseUrl,
  requestSkillhubJson,
  SKILLHUB_FALLBACK_API_BASE_PATH,
  splitNamespaceFromCanonicalSlug,
} from "./skillhub-common.js";

/** 内置市场 id；必须与 packages/shared 的 DEFAULT_PLUGIN_MARKETPLACES 一致，否则 addMarketplace 的 id 校验会拒绝。 */
export const SKILLHUB_MARKETPLACE_ID = "ucas-aihub";

// SkillHub 目录里与官方市场重复的技能：官方 `documents`/`spreadsheets` 插件已提供同名能力，
// 放出来员工会看到两套。这是客户端侧的产品口径（服务端没有 pinned/featured，只有 labels 与 hidden）。
const SKILLHUB_HIDDEN_SLUGS: ReadonlySet<string> = new Set(["docx", "pptx", "xlsx"]);

const WELL_KNOWN_PATH = "/.well-known/clawhub.json";
const CATALOG_PAGE_SIZE = 50;
const CATALOG_MAX_PAGES = 40;

export interface SkillhubMarketplaceSource {
  baseUrl: string;
  description?: string;
  name?: string;
  source: "skillhub";
}

export interface SkillhubCatalogItem {
  displayName?: string;
  latestVersion?: { version?: unknown };
  slug?: string;
  summary?: string;
}

export function isSkillhubMarketplaceSource(value: unknown): value is SkillhubMarketplaceSource {
  if (!isRecord(value)) return false;
  return value.source === "skillhub" && typeof value.baseUrl === "string";
}

/** 发现 API 基址：优先读 well-known，缺失时回退固定路径；跨 origin 的声明一律拒绝。 */
export async function discoverSkillhubApiBase(input: {
  baseUrl: string;
  client: HttpClientPort;
  signal?: AbortSignal;
}): Promise<string> {
  const baseUrl = normalizeSkillhubBaseUrl(input.baseUrl);
  let declared: unknown;
  try {
    const { json, status } = await requestSkillhubJson({
      client: input.client,
      signal: input.signal,
      url: `${baseUrl}${WELL_KNOWN_PATH}`,
    });
    if (status >= 200 && status < 300 && isRecord(json)) declared = json.apiBase;
  } catch {
    // 老版本可能没有 well-known；发现失败不应让整个市场不可用，回退到固定路径。
    declared = undefined;
  }
  if (typeof declared !== "string" || declared.trim().length === 0) {
    return `${baseUrl}${SKILLHUB_FALLBACK_API_BASE_PATH}`;
  }
  const resolved = new URL(declared.trim(), `${baseUrl}/`);
  if (resolved.origin !== new URL(baseUrl).origin) {
    throw new Error(`Skillhub apiBase must stay on the marketplace origin: ${declared}`);
  }
  return resolved.toString().replace(/\/+$/u, "");
}

export async function fetchSkillhubCatalog(input: {
  apiBase: string;
  client: HttpClientPort;
  signal?: AbortSignal;
}): Promise<SkillhubCatalogItem[]> {
  const items: SkillhubCatalogItem[] = [];
  let page = 0;
  for (let pageCount = 0; pageCount < CATALOG_MAX_PAGES; pageCount += 1) {
    const { json } = await requestSkillhubJson({
      client: input.client,
      signal: input.signal,
      url: `${input.apiBase}/skills?page=${page}&limit=${CATALOG_PAGE_SIZE}`,
    });
    const record = isRecord(json) ? json : {};
    const pageItems = Array.isArray(record.items) ? record.items : [];
    for (const item of pageItems) {
      if (isRecord(item)) items.push(item as SkillhubCatalogItem);
    }
    // 越界时服务端返回空数组且 nextCursor 为 null，不能靠空列表判断结束。
    const next = readNextCatalogPage(record.nextCursor);
    if (next === null) break;
    page = next;
  }
  return items;
}

/**
 * 把 SkillHub 目录归一化成 marketplace manifest 原文（交给 normalizeMarketplaceManifest）。
 * 条目 source 自带 baseUrl/apiBase/namespace/slug/version，安装与重装都只依赖条目本身。
 */
export function buildSkillhubMarketplaceManifestRaw(input: {
  apiBase: string;
  baseUrl: string;
  description?: string;
  items: readonly SkillhubCatalogItem[];
  name?: string;
}): Record<string, unknown> {
  const plugins = input.items.flatMap((item) => {
    const canonicalSlug = typeof item.slug === "string" ? item.slug.trim() : "";
    const version = readCatalogVersion(item);
    if (!canonicalSlug || !version || SKILLHUB_HIDDEN_SLUGS.has(canonicalSlug)) return [];
    const { namespace } = splitNamespaceFromCanonicalSlug(canonicalSlug);
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const displayName =
      typeof item.displayName === "string" && item.displayName.trim().length > 0
        ? item.displayName.trim()
        : canonicalSlug;
    return [
      {
        name: canonicalSlug,
        ...(summary.length > 0 ? { description: summary } : {}),
        displayName,
        source: {
          apiBase: input.apiBase,
          baseUrl: input.baseUrl,
          namespace,
          slug: canonicalSlug,
          source: "skillhub",
          version,
        },
        version,
      },
    ];
  });
  return {
    name:
      input.name?.trim() ||
      `skillhub-${createHash("sha256").update(normalizeSkillhubBaseUrl(input.baseUrl)).digest("hex").slice(0, 16)}`,
    ...(input.description ? { description: input.description } : {}),
    plugins,
  };
}

function readNextCatalogPage(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readCatalogVersion(item: SkillhubCatalogItem): string {
  const version = item.latestVersion?.version;
  return typeof version === "string" ? version.trim() : "";
}
