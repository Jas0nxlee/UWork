import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 随包下发的「远控入口」配置：桌面自己的 relay 地址 + 二维码指向的手机页地址。
 *
 * 为什么要单独一个配置文件：默认实现把这两个地址钉在 ZCode 侧
 * （`resolveWebRemoteControlRelayWsUrl` 对任何 endpoint 都回 `wss://zcode.z.ai/ws`，
 * 手机页默认 `https://zcode.z.ai/remote/v4`），而 UWork 的远控要走自建入口。
 * 这里让构建/部署方一次给全两处，避免「relay 换了但二维码还指向别人的页面」。
 */
export interface MobileRemoteControlConfig {
  remotePageBaseUrl: string;
  relayWsUrl: string;
}

const MAX_CONFIG_BYTES = 16_384;

export interface ResolveMobileRemoteControlConfigPathOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export function resolveMobileRemoteControlConfigFilePath(
  options: ResolveMobileRemoteControlConfigPathOptions,
): string {
  return options.isPackaged
    ? join(options.resourcesPath, "config", "mobile-remote-control.json")
    : // dev：appPath 是 packages/desktop，配置在仓库根 config/ 下（与 config/default.json 同处）。
      join(options.appPath, "..", "..", "config", "mobile-remote-control.json");
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * 手机页地址：必须 HTTPS（且是子路径，二维码会往它后面拼 query）；
 * 只有本机调试允许 http。
 */
function parseRemotePageBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  if (!secure) return null;
  // 根路径没法承载 /remote/v4 路由（routePath 会退化成 /remote），二维码也拼不出可用链接。
  if (!url.pathname || url.pathname === "/") return null;
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** relay 地址：必须 wss（本机调试允许 ws），不接受路径以外的 query/hash。 */
function parseRelayWsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === "wss:" || (url.protocol === "ws:" && isLocalHost(url.hostname));
  if (!secure) return null;
  if (url.search || url.hash) return null;
  return url.toString();
}

export function parseMobileRemoteControlConfig(raw: unknown): MobileRemoteControlConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const remotePageBaseUrl = parseRemotePageBaseUrl(record["remotePageBaseUrl"]);
  const relayWsUrl = parseRelayWsUrl(record["relayWsUrl"]);
  if (!remotePageBaseUrl || !relayWsUrl) return null;
  return { remotePageBaseUrl, relayWsUrl };
}

export interface MobileRemoteControlOverrides {
  relayWsUrl?: string;
  remotePageBaseUrl?: string;
}

/**
 * 入口地址的取值优先级：**环境变量（调试覆盖）> 随包配置 > 内置默认**。
 * 返回 undefined 表示「不覆盖」，由调用方沿用 ZCode 侧的默认推导。
 */
export function resolveMobileRemoteControlOverrides(options: {
  envRelayWsUrl?: string | undefined;
  envRemotePageBaseUrl?: string | undefined;
  config: MobileRemoteControlConfig | null;
}): MobileRemoteControlOverrides {
  const relayWsUrl = options.envRelayWsUrl?.trim() || options.config?.relayWsUrl;
  const remotePageBaseUrl =
    options.envRemotePageBaseUrl?.trim() || options.config?.remotePageBaseUrl;
  return {
    ...(relayWsUrl ? { relayWsUrl } : {}),
    ...(remotePageBaseUrl ? { remotePageBaseUrl } : {}),
  };
}

export interface ReadMobileRemoteControlConfigOptions extends ResolveMobileRemoteControlConfigPathOptions {
  warn?(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 读不到 / 不合法时返回 null，由调用方保持既有默认行为（绝不因为一个配置坏掉就让远控不可用）。
 */
export function readMobileRemoteControlConfigSync(
  options: ReadMobileRemoteControlConfigOptions,
): MobileRemoteControlConfig | null {
  const filePath = resolveMobileRemoteControlConfigFilePath(options);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (raw.length > MAX_CONFIG_BYTES) {
    options.warn?.("[web-remote-control] mobile remote control config too large, ignored", {
      filePath,
    });
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    options.warn?.("[web-remote-control] mobile remote control config is not valid JSON", {
      filePath,
    });
    return null;
  }
  const config = parseMobileRemoteControlConfig(decoded);
  if (!config) {
    options.warn?.("[web-remote-control] mobile remote control config rejected", { filePath });
    return null;
  }
  return config;
}
