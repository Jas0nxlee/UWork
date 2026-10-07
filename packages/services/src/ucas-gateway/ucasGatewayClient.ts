import { z } from "zod";
import {
  normalizeUcasGatewayBaseUrl,
  ucasGatewayKeySchema,
  ucasGatewaySubscriptionSchema,
  ucasGatewayUsageStatsSchema,
  ucasGatewayUserSchema,
  type UcasGatewayKey,
  type UcasGatewaySubscription,
  type UcasGatewayUsageRequest,
  type UcasGatewayUsageStats,
  type UcasGatewayUser,
} from "@zcode/shared";

const MAX_RESPONSE_BYTES = 512 * 1024;

/** 网关请求失败分类：鉴权、网络、HTTP 与响应格式分开，供 UI 给出不同提示。 */
export class UcasGatewayRequestError extends Error {
  constructor(
    readonly kind: "unauthorized" | "network" | "http" | "invalid",
    readonly status?: number,
  ) {
    super(`UCAS gateway request failed: ${kind}`);
  }
}

const idSchema = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
const optionalText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? trimmed : null;
  });

const wireUserSchema = z.object({
  id: idSchema,
  org_id: z.string().min(1),
  role: optionalText,
  wecom_userid: optionalText,
  name: z.string().min(1),
  email: optionalText,
  avatar: optionalText,
  department: optionalText,
  position: optionalText,
  monthly_budget: z.number().finite().nullable().optional(),
});
const wireAuthRefreshSchema = z.object({ token: z.string().min(1), user: wireUserSchema });

const wireKeySchema = z.object({
  id: idSchema,
  alias: optionalText,
  masked_key: z.string().min(1),
  status: z.string().min(1),
});
const wireKeysSchema = z.object({ keys: z.array(wireKeySchema) });
const wireGeneratedKeySchema = z.object({
  id: idSchema,
  key: z.string().min(1),
  masked_key: z.string().min(1),
  status: z.string().optional(),
});
const wireRevealSchema = z.object({ key: z.string().min(1) });

const wireOrgsSchema = z.object({
  orgs: z.array(z.object({ id: idSchema, name: z.string(), slug: z.string() })),
  llm_base_url: z.string().min(1),
  llm_base_url_internal: optionalText,
});

const wireSubscriptionsSchema = z.object({
  subscriptions: z.array(
    z.object({
      plan_id: idSchema,
      plan_title: z.string(),
      amount_total: z.number().finite().nonnegative(),
      amount_used: z.number().finite().nonnegative(),
      next_reset_time: z.number().finite().nonnegative().nullable().optional(),
      status: z.string(),
    }),
  ),
});

const wireUsageStatsSchema = z.object({
  period: z.enum(["7d", "month", "30d"]),
  metric: z.enum(["requests", "cost", "tokens"]),
  from: z.string(),
  until: z.string(),
  summary: z.object({
    requestCount: z.number().finite().nonnegative(),
    successCount: z.number().finite().nonnegative(),
    successRate: z.number().finite(),
    cost: z.number().finite(),
    averageCost: z.number().finite(),
    promptTokens: z.number().finite().nonnegative(),
    completionTokens: z.number().finite().nonnegative(),
    totalTokens: z.number().finite().nonnegative(),
    cacheReadTokens: z.number().finite().nonnegative(),
    cacheCreationTokens: z.number().finite().nonnegative(),
  }),
  trend: z.array(
    z.object({
      date: z.string(),
      requestCount: z.number().finite().nonnegative(),
      cost: z.number().finite(),
      tokens: z.number().finite().nonnegative(),
    }),
  ),
  models: z.array(
    z.object({
      model: z.string(),
      requestCount: z.number().finite().nonnegative(),
      cost: z.number().finite(),
      share: z.number().finite(),
    }),
  ),
});

const wirePlanModelsSchema = z.object({
  models: z.array(z.string()),
  unrestricted: z.boolean(),
  hasSubscription: z.boolean(),
});
const wireEndpointModelsSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

export interface UcasGatewayClientOptions {
  /** control-plane 根地址（与企微认证服务同源）。 */
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface UcasGatewayClient {
  readProfile(): Promise<UcasGatewayUser>;
  listKeys(): Promise<readonly UcasGatewayKey[]>;
  generateKey(alias: string): Promise<{ key: UcasGatewayKey; apiKey: string }>;
  revealKey(keyId: string): Promise<string>;
  readGatewayEndpoints(): Promise<{ publicBaseUrl: string; internalBaseUrl: string | null }>;
  readSubscriptions(): Promise<readonly UcasGatewaySubscription[]>;
  readUsage(request: UcasGatewayUsageRequest): Promise<UcasGatewayUsageStats>;
  readPlanModels(): Promise<{
    models: readonly string[];
    unrestricted: boolean;
    hasSubscription: boolean;
  }>;
  listEndpointModels(baseUrl: string, apiKey: string): Promise<readonly string[]>;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new UcasGatewayRequestError("invalid");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new UcasGatewayRequestError("invalid");
  }
}

function parseWire<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UcasGatewayRequestError("invalid");
  return parsed.data;
}

export function createUcasGatewayClient(options: UcasGatewayClientOptions): UcasGatewayClient {
  const request = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  const send = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    authorization: string = `Bearer ${options.token}`,
    base: string = options.apiBaseUrl,
    requestTimeoutMs: number = timeoutMs,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(new URL(path, base), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new UcasGatewayRequestError("network");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UcasGatewayRequestError("unauthorized", response.status);
    }
    if (!response.ok) throw new UcasGatewayRequestError("http", response.status);
    return readJson(response);
  };
  const toKey = (raw: z.infer<typeof wireKeySchema>): UcasGatewayKey =>
    ucasGatewayKeySchema.parse({
      id: raw.id,
      alias: raw.alias ?? "",
      maskedKey: raw.masked_key,
      status: raw.status,
    });
  return {
    async readProfile() {
      const raw = parseWire(wireAuthRefreshSchema, await send("POST", "/api/auth/refresh"));
      return ucasGatewayUserSchema.parse({
        id: raw.user.id,
        orgId: raw.user.org_id,
        name: raw.user.name,
        role: raw.user.role ?? "user",
        wecomUserId: raw.user.wecom_userid,
        email: raw.user.email,
        avatar: raw.user.avatar,
        department: raw.user.department,
        position: raw.user.position,
        monthlyBudgetUsd: raw.user.monthly_budget ?? null,
      });
    },
    async listKeys() {
      const raw = parseWire(wireKeysSchema, await send("GET", "/api/keys"));
      return raw.keys.map(toKey);
    },
    async generateKey(alias) {
      const raw = parseWire(
        wireGeneratedKeySchema,
        await send("POST", "/api/keys/generate", { alias }),
      );
      return {
        key: ucasGatewayKeySchema.parse({
          id: raw.id,
          alias,
          maskedKey: raw.masked_key,
          status: raw.status ?? "active",
        }),
        apiKey: raw.key,
      };
    },
    async revealKey(keyId) {
      const raw = parseWire(
        wireRevealSchema,
        await send("GET", `/api/keys/${encodeURIComponent(keyId)}/reveal`),
      );
      return raw.key;
    },
    async readGatewayEndpoints() {
      const raw = parseWire(wireOrgsSchema, await send("GET", "/api/auth/orgs"));
      return {
        publicBaseUrl: normalizeUcasGatewayBaseUrl(raw.llm_base_url),
        internalBaseUrl: raw.llm_base_url_internal
          ? normalizeUcasGatewayBaseUrl(raw.llm_base_url_internal)
          : null,
      };
    },
    async readSubscriptions() {
      const raw = parseWire(wireSubscriptionsSchema, await send("GET", "/api/usage"));
      return raw.subscriptions.map((item) =>
        ucasGatewaySubscriptionSchema.parse({
          planId: item.plan_id,
          planTitle: item.plan_title,
          amountTotal: item.amount_total,
          amountUsed: item.amount_used,
          nextResetTime: item.next_reset_time ?? null,
          status: item.status,
        }),
      );
    },
    async readUsage(input) {
      const query = new URLSearchParams({
        period: input.period,
        metric: input.metric,
        ...(input.force ? { refresh: "1" } : {}),
      });
      // 服务端已改为按天汇总（历史天读几十行，当天实时聚合）：实测冷启动 2.3 秒、
      // 常态 0.1 秒级。这里仍给 30 秒余量，避免慢网络被误报成网络不可达。
      const raw = parseWire(
        wireUsageStatsSchema,
        await send(
          "GET",
          `/api/usage/stats?${query.toString()}`,
          undefined,
          undefined,
          undefined,
          30000,
        ),
      );
      // 服务端 successRate 是百分数（usageStats.roundPercent 产出 0-100），
      // 视图契约统一用 0-1 比例，避免 UI 再乘一次 100。
      return ucasGatewayUsageStatsSchema.parse({
        ...raw,
        summary: { ...raw.summary, successRate: raw.summary.successRate / 100 },
      });
    },
    async readPlanModels() {
      const raw = parseWire(wirePlanModelsSchema, await send("GET", "/api/usage/models"));
      return {
        models: [...new Set(raw.models.map((model) => model.trim()).filter(Boolean))],
        unrestricted: raw.unrestricted,
        hasSubscription: raw.hasSubscription,
      };
    },
    async listEndpointModels(baseUrl, apiKey) {
      const raw = parseWire(
        wireEndpointModelsSchema,
        await send("GET", "/models", undefined, `Bearer ${apiKey}`, baseUrl),
      );
      return [...new Set(raw.data.map((item) => item.id.trim()).filter(Boolean))];
    },
  };
}
