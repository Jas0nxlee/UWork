import { z } from "zod";

const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });

const MAX_ORGANIZATIONS = 16;

/**
 * 一个可选组织（子公司）：全部是可随安装包分发的公开参数，严格拒绝 Secret 等凭据字段。
 * `label` 只用于展示（登录选择器与身份菜单），缺失时展示 `orgId`。
 */
export const wecomIdentityOrganizationSchema = z
  .object({
    orgId: z.string().trim().min(1).max(256),
    corpId: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
    agentId: z.string().regex(/^\d{1,20}$/),
    label: z.string().trim().min(1).max(64).optional(),
    /**
     * 本组织的授权回调地址。企微要求 `redirect_uri` 的域名与该企业应用后台配置的
     * 「授权回调域名」完全一致，而各子公司的入口域名不同，所以回调地址必须能按组织覆盖；
     * 缺省时用顶层 `callbackUrl`（单组织部署或三家共用同一域名时写顶层即可）。
     */
    callbackUrl: httpsUrl.optional(),
  })
  .strict();
export type WeComIdentityOrganization = z.infer<typeof wecomIdentityOrganizationSchema>;

/**
 * 旧版单组织形态 `{corpId, agentId, orgId}` 归一化成清单形式。
 * 已发布安装包与本机覆盖仍是单组织文件，不能因为引入多组织就让它们失效。
 */
function normalizeWeComIdentityConfigInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.organizations) || value.orgId === undefined) return value;
  const { orgId, corpId, agentId, ...rest } = value;
  return { ...rest, organizations: [{ orgId, corpId, agentId }] };
}

/** 可随安装包分发的公开参数；严格拒绝 Secret、Token 和其它凭据字段。 */
export const wecomIdentityConfigSchema = z.preprocess(
  normalizeWeComIdentityConfigInput,
  z
    .object({
      /** 控制面基址（三家共用一个控制面）；必须是纯 origin。 */
      apiBaseUrl: httpsUrl,
      /** 缺省授权回调地址：单组织部署写这里，多组织且各家回调域名不同时写在各组织上。 */
      callbackUrl: httpsUrl.optional(),
      /** 至少一个组织；单组织部署写一个元素。多组织时登录卡片按此清单展示选择。 */
      organizations: z.array(wecomIdentityOrganizationSchema).min(1).max(MAX_ORGANIZATIONS),
      /** 首次登录预选的组织；也用于按公司分发的预置包。必须出现在 organizations 里。 */
      defaultOrgId: z.string().trim().min(1).max(256).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const api = new URL(value.apiBaseUrl);
      if (api.pathname !== "/" || api.search || api.hash) {
        context.addIssue({ code: "custom", message: "API base URL must be an origin" });
      }
      const seen = new Set<string>();
      for (const organization of value.organizations) {
        if (seen.has(organization.orgId)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate organization in identity config",
          });
        }
        seen.add(organization.orgId);
        // 每个组织都必须有可用的回调地址；回调域名由各家企微应用后台校验，客户端只保证形状。
        const callback = resolveWeComIdentityCallbackUrl(
          value as WeComIdentityConfig,
          organization,
        );
        if (!callback) {
          context.addIssue({
            code: "custom",
            message: `Organization has no callback URL: ${organization.orgId}`,
          });
          continue;
        }
        const parsed = new URL(callback);
        if (parsed.search || parsed.hash) {
          context.addIssue({
            code: "custom",
            message: "Callback URL must not carry query or hash",
          });
        }
      }
      if (value.defaultOrgId !== undefined && !seen.has(value.defaultOrgId)) {
        context.addIssue({ code: "custom", message: "Default organization is not in the list" });
      }
    }),
);
export type WeComIdentityConfig = z.infer<typeof wecomIdentityConfigSchema>;

/** 组织的授权回调地址：组织级覆盖优先，其次顶层缺省。 */
export function resolveWeComIdentityCallbackUrl(
  config: Pick<WeComIdentityConfig, "callbackUrl">,
  organization: Pick<WeComIdentityOrganization, "callbackUrl">,
): string | undefined {
  return organization.callbackUrl ?? config.callbackUrl;
}

/**
 * 解析目标组织：显式 `orgId` → `defaultOrgId` → 清单唯一项；未命中返回 undefined（不猜、不回落别家）。
 * 显式传入的 `orgId` 必须在清单内，调用方据此拒绝未列出的组织。
 */
export function resolveWeComIdentityOrganization(
  config: WeComIdentityConfig,
  orgId?: string | null,
): WeComIdentityOrganization | undefined {
  const wanted = orgId?.trim();
  if (wanted) return config.organizations.find((organization) => organization.orgId === wanted);
  const fallback =
    config.defaultOrgId ??
    (config.organizations.length === 1 ? config.organizations[0]!.orgId : undefined);
  return fallback
    ? config.organizations.find((organization) => organization.orgId === fallback)
    : undefined;
}

/** 组织展示名：`label` 优先，缺失时用 `orgId`（身份来自服务端回包，不从本地选择值推导）。 */
export function weComIdentityOrganizationLabel(organization: WeComIdentityOrganization): string {
  return organization.label ?? organization.orgId;
}
