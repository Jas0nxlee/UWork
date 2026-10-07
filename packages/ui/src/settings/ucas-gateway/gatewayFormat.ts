/** 企业网关展示格式化：金额、计数、Token、时间与网关主机名，全部走 Intl 与固定单位。 */
export function formatUsd(locale: string, value: number): string {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

export function formatCount(locale: string, value: number): string {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(locale, {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10000 ? 1 : 0,
  }).format(value);
}

export function formatTokens(locale: string, value: number): string {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercentValue(locale: string, value: number): string {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: value >= 0.1 ? 0 : 1,
  }).format(value);
}

/** 服务端返回 Unix 秒；无效值不猜测时间。 */
export function formatResetTime(locale: string, epochSeconds: number | null): string | null {
  if (epochSeconds === null || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(epochSeconds * 1000));
}

export function formatSyncTime(locale: string, epochMs: number): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(epochMs));
}

/** 只展示主机名与端口，不把完整网关路径铺在界面上。 */
export function gatewayHostLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

export function shortModelName(model: string): string {
  return model.length > 28 ? `${model.slice(0, 27)}…` : model;
}
