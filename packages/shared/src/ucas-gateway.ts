import { z } from "zod";

/** control-plane 下发的模型入口不含 OpenAI 兼容前缀，Provider Base URL 必须补上它。 */
export const UCAS_GATEWAY_API_SUFFIX = "/v1";

/** 固定地址语义保持一致：去尾斜杠；只有根路径才补 `/v1`，已有路径原样保留。 */
export function normalizeUcasGatewayBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("网关地址不能为空");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("网关地址必须是 HTTP(S) URL");
  if (!url.pathname || url.pathname === "/") url.pathname = UCAS_GATEWAY_API_SUFFIX;
  return url.href.replace(/\/+$/, "");
}

/** 服务端返回的角色；未知取值按普通成员处理，不阻断登录与展示。 */
export const ucasGatewayUserSchema = z.object({
  id: z.string().trim().min(1).max(256),
  orgId: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  role: z.string().trim().max(64),
  wecomUserId: z.string().trim().max(256).nullable(),
  email: z.string().trim().max(320).nullable(),
  avatar: z.string().trim().max(2048).nullable(),
  department: z.string().trim().max(512).nullable(),
  position: z.string().trim().max(512).nullable(),
  monthlyBudgetUsd: z.number().finite().nonnegative().nullable(),
});
export type UcasGatewayUser = z.infer<typeof ucasGatewayUserSchema>;

export const ucasGatewayEndpointSchema = z.object({
  /** 已规范化、可直接写入 Provider 的地址（含 `/v1`）。 */
  baseUrl: z.string().min(1).max(2048),
  publicBaseUrl: z.string().min(1).max(2048),
  internalBaseUrl: z.string().min(1).max(2048).nullable(),
  source: z.enum(["public", "internal"]),
});
export type UcasGatewayEndpoint = z.infer<typeof ucasGatewayEndpointSchema>;

export const ucasGatewayKeySchema = z.object({
  id: z.string().trim().min(1).max(256),
  alias: z.string().trim().max(128),
  maskedKey: z.string().trim().min(1).max(128),
  status: z.string().trim().max(64),
});
export type UcasGatewayKey = z.infer<typeof ucasGatewayKeySchema>;

export const ucasGatewaySubscriptionSchema = z.object({
  planId: z.string().trim().max(256),
  planTitle: z.string().trim().max(256),
  amountTotal: z.number().finite().nonnegative(),
  amountUsed: z.number().finite().nonnegative(),
  nextResetTime: z.number().int().nonnegative().nullable(),
  status: z.string().trim().max(64),
});
export type UcasGatewaySubscription = z.infer<typeof ucasGatewaySubscriptionSchema>;

export const ucasGatewayUsagePeriodSchema = z.enum(["7d", "month", "30d"]);
export type UcasGatewayUsagePeriod = z.infer<typeof ucasGatewayUsagePeriodSchema>;
export const ucasGatewayUsageMetricSchema = z.enum(["requests", "cost", "tokens"]);
export type UcasGatewayUsageMetric = z.infer<typeof ucasGatewayUsageMetricSchema>;

export const ucasGatewayUsageSummarySchema = z.object({
  requestCount: z.number().finite().nonnegative(),
  successCount: z.number().finite().nonnegative(),
  /** 成功比例（0-1）；服务端 wire 字段是百分数，客户端换算后进入视图。 */
  successRate: z.number().finite(),
  cost: z.number().finite(),
  averageCost: z.number().finite(),
  promptTokens: z.number().finite().nonnegative(),
  completionTokens: z.number().finite().nonnegative(),
  totalTokens: z.number().finite().nonnegative(),
  cacheReadTokens: z.number().finite().nonnegative(),
  cacheCreationTokens: z.number().finite().nonnegative(),
});

export const ucasGatewayUsageStatsSchema = z.object({
  period: ucasGatewayUsagePeriodSchema,
  metric: ucasGatewayUsageMetricSchema,
  from: z.string().max(64),
  until: z.string().max(64),
  summary: ucasGatewayUsageSummarySchema,
  trend: z
    .array(
      z.object({
        date: z.string().max(64),
        requestCount: z.number().finite().nonnegative(),
        cost: z.number().finite(),
        tokens: z.number().finite().nonnegative(),
      }),
    )
    .max(400),
  models: z
    .array(
      z.object({
        model: z.string().max(256),
        requestCount: z.number().finite().nonnegative(),
        cost: z.number().finite(),
        share: z.number().finite(),
      }),
    )
    .max(400),
});
export type UcasGatewayUsageStats = z.infer<typeof ucasGatewayUsageStatsSchema>;

export const ucasGatewayModelsSchema = z.object({
  available: z.array(z.string().trim().min(1).max(256)).max(1000),
  unrestricted: z.boolean(),
  hasSubscription: z.boolean(),
  appliedCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
});
export type UcasGatewayModels = z.infer<typeof ucasGatewayModelsSchema>;

export const ucasGatewayErrorSchema = z.enum([
  "signed-out",
  "unconfigured",
  "unauthorized",
  "network",
  "failed",
]);
export type UcasGatewayError = z.infer<typeof ucasGatewayErrorSchema>;

export const ucasGatewayViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  status: z.enum(["signed-out", "idle", "syncing", "ready", "error"]),
  configured: z.boolean(),
  user: ucasGatewayUserSchema.nullable(),
  endpoint: ucasGatewayEndpointSchema.nullable(),
  key: ucasGatewayKeySchema.nullable(),
  subscriptions: z.array(ucasGatewaySubscriptionSchema).max(32),
  usage: ucasGatewayUsageStatsSchema.nullable(),
  models: ucasGatewayModelsSchema.nullable(),
  lastSyncedAt: z.number().int().nonnegative().nullable(),
  error: ucasGatewayErrorSchema.nullable(),
});
export type UcasGatewayView = z.infer<typeof ucasGatewayViewSchema>;

export const ucasGatewaySyncReasonSchema = z.enum([
  "login",
  "startup",
  "manual",
  "usage",
  "models",
  "replace-key",
]);
export type UcasGatewaySyncReason = z.infer<typeof ucasGatewaySyncReasonSchema>;

export const ucasGatewaySyncResultSchema = z.object({
  view: ucasGatewayViewSchema,
  /** 本次调用是否真正执行了登录态同步；未登录/未配置为 false。 */
  committed: z.boolean(),
  apiKeyApplied: z.boolean(),
  /** 企业账号此前已有 Key（服务端返回或本次读取），本次未生成新 Key。 */
  apiKeyReused: z.boolean(),
  /** 同步结束后 UCAS 供应商是否具备可用的 API Key（用于决定是否回退手工输入）。 */
  providerHasApiKey: z.boolean(),
  modelsAdded: z.number().int().nonnegative(),
  modelsSkipped: z.number().int().nonnegative(),
});
export type UcasGatewaySyncResult = z.infer<typeof ucasGatewaySyncResultSchema>;

export const ucasGatewayUsageRequestSchema = z.object({
  period: ucasGatewayUsagePeriodSchema,
  metric: ucasGatewayUsageMetricSchema,
  force: z.boolean().optional(),
});
export type UcasGatewayUsageRequest = z.infer<typeof ucasGatewayUsageRequestSchema>;

/** 网关状态文件：只保存下次启动需要的端点解析结果与 Key 元数据，不含 Key 明文。 */
export const ucasGatewayStateSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().trim().min(1).max(256),
    orgId: z.string().trim().min(1).max(256),
    endpoint: ucasGatewayEndpointSchema,
    key: ucasGatewayKeySchema.nullable(),
    lastSyncedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type UcasGatewayState = z.infer<typeof ucasGatewayStateSchema>;
