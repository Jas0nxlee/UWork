import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  resolveWeComIdentityCallbackUrl,
  resolveWeComIdentityOrganization,
  wecomIdentityConfigSchema,
  type EnterpriseIdentitySession,
  type WeComIdentityOrganization,
} from "@zcode/shared";
import type {
  EnterpriseIdentityAdapter,
  EnterpriseIdentityOrganizationOption,
} from "./contract.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createIdentityIssuerDiagnostics,
  type IdentityIssuerDiagnostic,
} from "./identityIssuerDiagnostics.js";

export {
  resolveWeComIdentityCallbackUrl,
  resolveWeComIdentityOrganization,
  wecomIdentityConfigSchema,
  type WeComIdentityConfig,
  type WeComIdentityOrganization,
} from "@zcode/shared";

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
  /** 本次进程内登记的桌面握手 secret；不落盘、不进日志，仅用于 poll 认领。 */
  const handoffSecrets = new Map<string, string>();
  /** 每次尝试所属的组织：轮询认领时按它校验回包 org_id。 */
  const attemptOrganizations = new Map<string, string>();
  const logger = createServiceLogger("WeComIdentityAdapter");
  const diagnostics = createIdentityIssuerDiagnostics(
    options.onDiagnostic ??
      ((event) => logger.warn(undefined, "Identity issuer rejected login", event)),
  );
  const toSession = (raw: unknown, expectedOrgId: string) => {
    const parsed = authResponseSchema.safeParse(raw);
    if (!parsed.success) {
      diagnostics.schema(parsed.error.issues.map((issue) => issue.path.join(".")));
      throw new Error("Invalid identity response");
    }
    const response = parsed.data;
    if (response.user.org_id !== expectedOrgId) {
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
  const readResponse = async (response: Response, expectedOrgId: string) => {
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
    return toSession(body, expectedOrgId);
  };
  const restore = async (session: EnterpriseIdentitySession, signal: AbortSignal) => {
    const response = await post("/api/auth/refresh", signal, session.token);
    if (response.status === 401 || response.status === 403) return null;
    // 续期沿用会话自身的组织身份：换组织必须重新登录，不能靠 refresh 漂移。
    const { session: verified } = await readResponse(response, session.profile.tenantId);
    if (
      verified.profile.id !== session.profile.id ||
      verified.profile.tenantId !== session.profile.tenantId
    ) {
      diagnostics.failure("identity-changed");
      throw new Error("Identity changed during renewal");
    }
    return verified;
  };
  /** 尝试登记桌面握手；服务不支持时返回 null，由窗口内回调路径兜底。 */
  const startHandoff = async (
    signal: AbortSignal,
    orgId: string,
  ): Promise<{ id: string; secret: string } | null> => {
    try {
      const response = await post("/api/auth/handoff/start", signal, undefined, {
        org_id: orgId,
      });
      if (!response.ok) return null;
      const parsed = z
        .object({
          handoff_id: z.string().trim().min(1).max(256),
          handoff_secret: z.string().trim().min(1).max(256),
        })
        .safeParse(await readAuthResponse(response));
      return parsed.success
        ? { id: parsed.data.handoff_id, secret: parsed.data.handoff_secret }
        : null;
    } catch {
      return null;
    }
  };
  const toOption = (
    organization: WeComIdentityOrganization,
  ): EnterpriseIdentityOrganizationOption => ({
    id: organization.orgId,
    ...(organization.label ? { label: organization.label } : {}),
  });
  return {
    listOrganizations: () => config.organizations.map(toOption),
    resolveOrganization: (orgId) => {
      const organization = resolveWeComIdentityOrganization(config, orgId);
      return organization ? toOption(organization) : undefined;
    },
    async start(signal, orgId) {
      signal.throwIfAborted();
      const organization = resolveWeComIdentityOrganization(config, orgId);
      // 未配置/未列出的组织一律拒绝：白名单之外没有可用的企微应用，也不回落别家。
      if (!organization) throw new Error("Identity organization is not configured");
      // 企业微信桌面端会把回调交给系统浏览器，窗口内看不到一次性 code；
      // 因此尝试登记的 handoff id 同时充当本次尝试 id（进入回调地址的 uwork_nonce），
      // 桌面端再凭只留在本进程的 secret 认领会话。
      const handoff = await startHandoff(signal, organization.orgId);
      signal.throwIfAborted();
      const id = handoff?.id ?? randomUUID();
      if (handoff) handoffSecrets.set(id, handoff.secret);
      attemptOrganizations.set(id, organization.orgId);
      // 服务侧 state 固定承载组织；随机请求绑定放在回调地址，不能拿 orgId 代替防伪 nonce。
      // 回调域名必须逐组织取：企微要求 redirect_uri 的域名等于该企业应用后台配置的授权回调域，
      // 各子公司入口域名不同，用错域名会在授权页直接报「回调域名不一致」。
      const callbackUrl = resolveWeComIdentityCallbackUrl(config, organization);
      if (!callbackUrl) throw new Error("Identity organization has no callback URL");
      const callback = new URL(callbackUrl);
      callback.searchParams.set("uwork_nonce", id);
      const url = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
      url.search = new URLSearchParams({
        login_type: "CorpApp",
        appid: organization.corpId,
        agentid: organization.agentId,
        redirect_uri: callback.href,
        state: organization.orgId,
        lang: "zh",
      }).toString();
      return {
        id,
        authorizationUrl: url.href,
        callbackUrl: callback.href,
        expectedState: organization.orgId,
        expiresAt: now() + 300000,
      };
    },
    /** 桌面握手认领：网页（含桌面端打开的浏览器）完成登录后取回同一会话。 */
    async poll(attemptId, signal) {
      const secret = handoffSecrets.get(attemptId);
      const orgId = attemptOrganizations.get(attemptId);
      // 没有握手记录的尝试只能靠窗口内回调完成；轮询不得把它判成过期。
      if (!secret || !orgId) return { status: "pending" as const };
      const response = await post("/api/auth/handoff/claim", signal, undefined, {
        handoff_id: attemptId,
        handoff_secret: secret,
      });
      if (response.status === 202) return { status: "pending" as const };
      if (!response.ok) {
        handoffSecrets.delete(attemptId);
        attemptOrganizations.delete(attemptId);
        return { status: "expired" as const };
      }
      const { session } = toSession(await readAuthResponse(response), orgId);
      handoffSecrets.delete(attemptId);
      attemptOrganizations.delete(attemptId);
      return { status: "authenticated" as const, session };
    },
    async complete(code, signal, orgId) {
      z.string().min(1).max(4096).parse(code);
      const organization = resolveWeComIdentityOrganization(config, orgId);
      if (!organization) throw new Error("Identity organization is not configured");
      const response = await post("/api/auth/login", signal, undefined, {
        code,
        // 现有认证服务按 org_id 查组织；CorpID 或随机回调 state 不能替代该数据库标识。
        org_id: organization.orgId,
      });
      const result = await readResponse(response, organization.orgId);
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
