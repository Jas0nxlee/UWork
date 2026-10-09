import { z } from "zod";

export const enterpriseIdentityProfileSchema = z.object({
  id: z.string().trim().min(1).max(256),
  tenantId: z.string().trim().min(1).max(256),
  provider: z.literal("wecom"),
  displayName: z.string().trim().min(1).max(256),
});
export type EnterpriseIdentityProfile = z.infer<typeof enterpriseIdentityProfileSchema>;

export const enterpriseIdentitySessionSchema = z.object({
  profile: enterpriseIdentityProfileSchema,
  token: z.string().min(1).max(16384),
  expiresAt: z.number().int().positive(),
});
export type EnterpriseIdentitySession = z.infer<typeof enterpriseIdentitySessionSchema>;

const enterpriseIdentityAttemptBaseSchema = z.object({
  id: z.string().min(1).max(256),
  authorizationUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }, "Authorization requires HTTPS without embedded credentials"),
  expiresAt: z.number().int().positive(),
  /** 存在时由 Desktop 的隔离扫码视图接收 HTTPS 回调，不依赖业务轮询。 */
  callbackUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash;
    })
    .optional(),
  /** 兼容服务将 state 用作组织 ID；防伪 nonce 必须保留在 callbackUrl。 */
  expectedState: z.string().min(1).max(256).optional(),
});
function checkCallbackBinding(
  attempt: z.infer<typeof enterpriseIdentityAttemptBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (!attempt.callbackUrl) return;
  const callback = new URL(attempt.callbackUrl);
  const valid =
    attempt.expectedState === undefined
      ? !callback.search
      : callback.searchParams.getAll("uwork_nonce").length === 1 &&
        callback.searchParams.get("uwork_nonce") === attempt.id &&
        [...callback.searchParams.keys()].every((key) => key === "uwork_nonce");
  if (!valid) context.addIssue({ code: "custom", message: "Invalid enterprise callback binding" });
}
export const enterpriseIdentityAttemptSchema =
  enterpriseIdentityAttemptBaseSchema.superRefine(checkCallbackBinding);
export type EnterpriseIdentityAttempt = z.infer<typeof enterpriseIdentityAttemptSchema>;

const surfaceColor = z
  .string()
  .max(96)
  .regex(/^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([\d.%\s/+,-]+\))$/);
export const enterpriseLoginSurfaceSchema = z
  .object({
    bounds: z
      .object({
        x: z.number().finite().min(0).max(32768),
        y: z.number().finite().min(0).max(32768),
        width: z.number().finite().positive().max(16384),
        height: z.number().finite().positive().max(16384),
      })
      .strict(),
    appearance: z
      .object({
        backgroundColor: surfaceColor,
        foregroundColor: surfaceColor,
        fontFamily: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[\p{L}\p{N}\s_,"'-]+$/u),
        fontSize: z.number().finite().min(8).max(32),
        language: z.enum(["zh", "en"]).optional(),
      })
      .strict(),
  })
  .strict();
export type EnterpriseLoginSurface = z.infer<typeof enterpriseLoginSurfaceSchema>;
export const enterpriseLoginSurfaceUpdateSchema = z
  .object({
    id: z.string().min(1).max(256),
    surface: enterpriseLoginSurfaceSchema.nullable(),
  })
  .strict();
export type EnterpriseLoginSurfaceUpdate = z.infer<typeof enterpriseLoginSurfaceUpdateSchema>;

function checkEnterpriseLoginRoute(
  attempt: z.infer<typeof enterpriseIdentityAttemptBaseSchema>,
  context: z.RefinementCtx,
): void {
  const url = new URL(attempt.authorizationUrl);
  const query = url.searchParams;
  const unique = ["login_type", "appid", "agentid", "redirect_uri", "state"].every(
    (key) => query.getAll(key).length === 1,
  );
  if (
    url.origin !== "https://login.work.weixin.qq.com" ||
    url.pathname !== "/wwlogin/sso/login" ||
    url.hash ||
    !unique ||
    !query.get("appid") ||
    !/^\d+$/.test(query.get("agentid") ?? "") ||
    query.get("state") !== (attempt.expectedState ?? attempt.id) ||
    query.get("redirect_uri") !== attempt.callbackUrl ||
    query.get("login_type") !== "CorpApp"
  ) {
    context.addIssue({ code: "custom", message: "Invalid enterprise login route" });
  }
}
export const enterpriseLoginAuthorizationSchema = enterpriseIdentityAttemptBaseSchema
  .required({ callbackUrl: true })
  .strict()
  .superRefine(checkCallbackBinding)
  .superRefine(checkEnterpriseLoginRoute);
export type EnterpriseLoginAuthorization = z.infer<typeof enterpriseLoginAuthorizationSchema>;

/** 原生扫码内容挂在应用卡片内；授权参数校验沿用原边界，新增展示数据独立验证。 */
export const enterpriseLoginRequestSchema = enterpriseIdentityAttemptBaseSchema
  .extend({ surface: enterpriseLoginSurfaceSchema })
  .required({ callbackUrl: true })
  .strict()
  .superRefine(checkCallbackBinding)
  .superRefine(checkEnterpriseLoginRoute);
export type EnterpriseLoginRequest = z.infer<typeof enterpriseLoginRequestSchema>;

/** Host 与原生视图共用的回调边界；验证业务尝试，不信任网页附带的姓名或 Token。 */
export function readEnterpriseIdentityCallback(
  attempt: EnterpriseIdentityAttempt,
  value: string,
): string {
  if (!attempt.callbackUrl || value.length > 16384) throw new Error("Invalid enterprise callback");
  const expected = new URL(attempt.callbackUrl);
  const actual = new URL(value);
  const keys = [...actual.searchParams.keys()];
  const code = actual.searchParams.get("code");
  const compatibility = attempt.expectedState !== undefined;
  const nonceMatches = compatibility
    ? expected.searchParams.getAll("uwork_nonce").length === 1 &&
      expected.searchParams.get("uwork_nonce") === attempt.id &&
      actual.searchParams.getAll("uwork_nonce").length === 1 &&
      actual.searchParams.get("uwork_nonce") === attempt.id
    : !expected.search && !actual.searchParams.has("uwork_nonce");
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.username ||
    actual.password ||
    actual.hash ||
    actual.searchParams.getAll("state").length !== 1 ||
    actual.searchParams.get("state") !== (attempt.expectedState ?? attempt.id) ||
    actual.searchParams.getAll("code").length !== 1 ||
    !nonceMatches ||
    keys.some(
      (key) => key !== "state" && key !== "code" && !(compatibility && key === "uwork_nonce"),
    ) ||
    !code ||
    code.length > 4096
  )
    throw new Error("Invalid enterprise callback");
  return code;
}

/** 登录页/身份菜单展示用的组织条目；`label` 缺失时由 UI 回落 `id`。 */
const enterpriseIdentityOrganizationViewSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(64).nullable(),
  })
  .strict();

const base = {
  revision: z.number().int().nonnegative(),
  configured: z.boolean(),
  error: z.enum(["unconfigured", "failed", "expired"]).nullable(),
  /** 配置里可选的组织清单（长度 1 时不展示选择器）。 */
  organizations: z.array(enterpriseIdentityOrganizationViewSchema),
  /** 本机记住/默认的组织；未定或不在清单内时为 null。 */
  selectedOrgId: z.string().trim().min(1).max(256).nullable(),
};
export const enterpriseIdentityViewSchema = z.discriminatedUnion("status", [
  z.object({ ...base, status: z.literal("signed-out"), profile: z.null(), pending: z.null() }),
  z.object({
    ...base,
    status: z.literal("waiting"),
    profile: z.null(),
    pending: z.object({
      id: z.string().min(1),
      expiresAt: z.number().int().positive(),
      callbackUrl: z.string().url().optional(),
    }),
  }),
  z.object({
    ...base,
    status: z.literal("authenticated"),
    profile: enterpriseIdentityProfileSchema,
    pending: z.null(),
  }),
]);
export type EnterpriseIdentityView = z.infer<typeof enterpriseIdentityViewSchema>;

/** 仅扫码完成命令携带本次提交回执；身份事件与只读视图仍不包含尝试来源。 */
export const enterpriseIdentityCompletionSchema = z
  .object({
    view: enterpriseIdentityViewSchema,
    committedAttemptId: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.committedAttemptId && result.view.status !== "authenticated")
      context.addIssue({ code: "custom", message: "A committed login must be authenticated" });
  });
export type EnterpriseIdentityCompletion = z.infer<typeof enterpriseIdentityCompletionSchema>;

export const enterpriseIdentityPollResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("authenticated"), session: enterpriseIdentitySessionSchema }),
  z.object({ status: z.literal("expired") }),
]);
export type EnterpriseIdentityPollResult = z.infer<typeof enterpriseIdentityPollResultSchema>;
