// SkillHub 适配层共用的低层设施：HTTP 请求、JSON 读取与规范 slug/baseUrl 的解析规则。
//
// 契约见 specs/aihub-skill-source.md。

import type { HttpClientPort, HttpClientResponse } from "@zcode/contracts";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";

export const SKILLHUB_SOURCE_KIND = "skillhub";
/** 未取到 well-known 时的 API 基址回退路径（老版本没有发现文档）。 */
export const SKILLHUB_FALLBACK_API_BASE_PATH = "/api/v1";
export const SKILLHUB_FINGERPRINT_PREFIX = "sha256:";

const JSON_MAX_BYTES = 10 * 1024 * 1024;
const JSON_TIMEOUT_MS = 30_000;
const JSON_MAX_REDIRECTS = 5;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
// 规范 slug 规则来自服务端 CanonicalSlugMapper：global 命名空间直接是 slug，其余是 `<namespace>--<slug>`。
const CANONICAL_NAMESPACE_SEPARATOR = "--";
const GLOBAL_NAMESPACE = "global";

export function createSkillhubHttpClient(): HttpClientPort {
  return createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: JSON_MAX_BYTES,
    timeoutMs: JSON_TIMEOUT_MS,
  });
}

export async function requestSkillhubJson(input: {
  client: HttpClientPort;
  signal?: AbortSignal;
  url: string;
}): Promise<{ json: unknown; status: number }> {
  let currentUrl = input.url;
  for (let redirectCount = 0; redirectCount <= JSON_MAX_REDIRECTS; redirectCount += 1) {
    const response: HttpClientResponse = await input.client.request(
      {
        maxResponseBytes: JSON_MAX_BYTES,
        method: "GET",
        redirect: "manual",
        timeoutMs: JSON_TIMEOUT_MS,
        url: currentUrl,
      },
      { signal: input.signal },
    );
    if (isRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error(`Skillhub redirect is missing Location header: ${currentUrl}`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Failed to fetch SkillHub response: ${response.status} ${response.statusText}`,
      );
    }
    return {
      json: JSON.parse(new TextDecoder().decode(response.body)) as unknown,
      status: response.status,
    };
  }
  throw new Error(`Skillhub request exceeded redirect limit: ${input.url}`);
}

export function normalizeSkillhubBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Skillhub base URL is empty");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Skillhub base URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`Skillhub base URL must be HTTPS (or loopback HTTP): ${raw}`);
  }
  return trimmed.replace(/\/+$/u, "");
}

/** 规范 slug 反解；与服务端 fromCanonical 一致：在**第一个** `--` 处切分，没有则视为 global。 */
export function splitNamespaceFromCanonicalSlug(canonicalSlug: string): {
  namespace: string;
  slug: string;
} {
  const separatorIndex = canonicalSlug.indexOf(CANONICAL_NAMESPACE_SEPARATOR);
  if (separatorIndex > 0) {
    return {
      namespace: canonicalSlug.slice(0, separatorIndex),
      slug: canonicalSlug.slice(separatorIndex + CANONICAL_NAMESPACE_SEPARATOR.length),
    };
  }
  return { namespace: GLOBAL_NAMESPACE, slug: canonicalSlug };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRequiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Skillhub source requires a non-empty ${field}`);
  }
  return value.trim();
}

export function readOptionalTrimmedString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().replace(/\/+$/u, "")
    : undefined;
}

export function readFingerprintHex(fingerprint: string): string | undefined {
  const hex = fingerprint.startsWith(SKILLHUB_FINGERPRINT_PREFIX)
    ? fingerprint.slice(SKILLHUB_FINGERPRINT_PREFIX.length)
    : fingerprint;
  return SHA256_PATTERN.test(hex.toLowerCase()) ? hex.toLowerCase() : undefined;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
