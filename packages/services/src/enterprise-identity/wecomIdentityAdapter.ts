import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EnterpriseIdentitySession } from "@zcode/shared";
import type { EnterpriseIdentityAdapter } from "./contract.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createIdentityIssuerDiagnostics,
  type IdentityIssuerDiagnostic,
} from "./identityIssuerDiagnostics.js";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });
export const wecomIdentityConfigSchema = z
  .object({
    corpId: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
    agentId: z.string().regex(/^\d{1,20}$/),
    apiBaseUrl: httpsUrl,
    callbackUrl: httpsUrl,
    orgId: z.string().trim().min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const api = new URL(value.apiBaseUrl);
    const callback = new URL(value.callbackUrl);
    if (
      api.origin !== callback.origin ||
      api.pathname !== "/" ||
      api.search ||
      api.hash ||
      callback.search ||
      callback.hash
    ) {
      context.addIssue({
        code: "custom",
        message: "Callback must use the configured HTTPS issuer origin",
      });
    }
  });
export type WeComIdentityConfig = z.infer<typeof wecomIdentityConfigSchema>;

const authResponseSchema = z.object({
  token: z.string().min(1).max(16384),
  user: z.object({
    id: z
      .union([z.string().trim().min(1).max(256), z.number().int().nonnegative()])
      .transform(String),
    org_id: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(256),
  }),
  needsEmailAuth: z.boolean().optional(),
});

async function readAuthResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty identity response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) {
        await reader.cancel();
        throw new Error("Identity response too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 官方 Web 登录 + 已有认证服务 code 交换；Secret 始终留在服务端。 */
export function createWeComIdentityAdapter(
  rawConfig: unknown,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    onDiagnostic?: (event: IdentityIssuerDiagnostic) => void;
  } = {},
): EnterpriseIdentityAdapter {
  const config = wecomIdentityConfigSchema.parse(rawConfig);
  const request = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const logger = createServiceLogger("WeComIdentityAdapter");
  const diagnostics = createIdentityIssuerDiagnostics(
    options.onDiagnostic ??
      ((event) => logger.warn(undefined, "Identity issuer rejected login", event)),
  );
  const toSession = (raw: unknown) => {
    const parsed = authResponseSchema.safeParse(raw);
    if (!parsed.success) {
      diagnostics.schema(parsed.error.issues.map((issue) => issue.path.join(".")));
      throw new Error("Invalid identity response");
    }
    const response = parsed.data;
    if (response.user.org_id !== config.orgId) {
      diagnostics.failure("identity-changed");
      throw new Error("Identity issuer organization mismatch");
    }
    const parts = response.token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      diagnostics.failure("token-format");
      throw new Error("Unsupported identity token");
    }
    // 此处只读取受信 HTTPS 服务响应中的有效期；恢复仍由服务端验证 Token，不能把 JWT 解码当作认证。
    let expiry: { exp: number };
    try {
      expiry = z
        .object({ exp: z.number().int().positive() })
        .parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    } catch {
      diagnostics.failure("token-expiry-claim");
      throw new Error("Invalid identity token expiry");
    }
    const expiresAt = expiry.exp * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) {
      diagnostics.failure("token-expired");
      throw new Error("Identity token expired");
    }
    const session: EnterpriseIdentitySession = {
      token: response.token,
      expiresAt,
      profile: {
        id: response.user.id,
        tenantId: response.user.org_id,
        provider: "wecom",
        displayName: response.user.name,
      },
    };
    return { session, needsEmailAuth: response.needsEmailAuth === true };
  };
  const post = async (
    path: string,
    signal: AbortSignal,
    token?: string,
    body?: unknown,
  ): Promise<Response> => {
    try {
      return await request(new URL(path, config.apiBaseUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      if (!signal.aborted) diagnostics.failure("network-failed");
      throw new Error("Identity issuer request failed");
    }
  };
  const readResponse = async (response: Response) => {
    let body: unknown;
    try {
      body = await readAuthResponse(response);
    } catch {
      if (response.ok) {
        diagnostics.failure("response-body");
        throw new Error("Invalid identity response body");
      }
    }
    if (!response.ok) {
      diagnostics.http(response.status, body);
      throw new Error("Identity issuer rejected request");
    }
    return toSession(body);
  };
  const restore = async (session: EnterpriseIdentitySession, signal: AbortSignal) => {
    const response = await post("/api/auth/refresh", signal, session.token);
    if (response.status === 401 || response.status === 403) return null;
    const { session: verified } = await readResponse(response);
    if (
      verified.profile.id !== session.profile.id ||
      verified.profile.tenantId !== session.profile.tenantId
    ) {
      diagnostics.failure("identity-changed");
      throw new Error("Identity changed during renewal");
    }
    return verified;
  };
  return {
    async start(signal) {
      signal.throwIfAborted();
      const id = randomUUID();
      // 服务侧 state 固定承载组织；随机请求绑定放在回调地址，不能拿 orgId 代替防伪 nonce。
      const callback = new URL(config.callbackUrl);
      callback.searchParams.set("uwork_nonce", id);
      const url = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
      url.search = new URLSearchParams({
        login_type: "CorpApp",
        appid: config.corpId,
        agentid: config.agentId,
        redirect_uri: callback.href,
        state: config.orgId,
        lang: "zh",
      }).toString();
      return {
        id,
        authorizationUrl: url.href,
        callbackUrl: callback.href,
        expectedState: config.orgId,
        expiresAt: now() + 300000,
      };
    },
    async complete(code, signal) {
      z.string().min(1).max(4096).parse(code);
      const response = await post("/api/auth/login", signal, undefined, {
        code,
        // 现有认证服务按 org_id 查组织；CorpID 或随机回调 state 不能替代该数据库标识。
        org_id: config.orgId,
      });
      const result = await readResponse(response);
      // 现有网页在已获得登录 Token 后补充邮箱资料；姓名登录须以服务端 refresh 确认会话，不能误拒绝该信息标记。
      if (!result.needsEmailAuth) return result.session;
      const verified = await restore(result.session, signal);
      if (!verified) {
        diagnostics.failure("additional-verification");
        throw new Error("Identity session was not verified");
      }
      return verified;
    },
    restore,
  };
}
