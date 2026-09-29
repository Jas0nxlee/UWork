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
  /** 存在时由 Desktop 的隔离登录窗口接收 HTTPS 回调，不依赖业务轮询。 */
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

export const enterpriseLoginPopupRequestSchema = enterpriseIdentityAttemptBaseSchema
  .required({ callbackUrl: true })
  .strict()
  .superRefine(checkCallbackBinding)
  .superRefine((attempt, context) => {
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
  });
export type EnterpriseLoginPopupRequest = z.infer<typeof enterpriseLoginPopupRequestSchema>;

/** Host 与原生窗口共用的回调边界；验证业务尝试，不信任网页附带的姓名或 Token。 */
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

const base = {
  revision: z.number().int().nonnegative(),
  configured: z.boolean(),
  error: z.enum(["unconfigured", "failed", "expired"]).nullable(),
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

export const enterpriseIdentityPollResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("authenticated"), session: enterpriseIdentitySessionSchema }),
  z.object({ status: z.literal("expired") }),
]);
export type EnterpriseIdentityPollResult = z.infer<typeof enterpriseIdentityPollResultSchema>;
