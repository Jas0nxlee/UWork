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

export const enterpriseIdentityAttemptSchema = z.object({
  id: z.string().min(1).max(256),
  authorizationUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }, "Authorization requires HTTPS without embedded credentials"),
  expiresAt: z.number().int().positive(),
});
export type EnterpriseIdentityAttempt = z.infer<typeof enterpriseIdentityAttemptSchema>;

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
    pending: z.object({ id: z.string().min(1), expiresAt: z.number().int().positive() }),
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
