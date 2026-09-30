import { z } from "zod";

const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });
/** 可随安装包分发的公开参数；严格拒绝 Secret、Token 和其它凭据字段。 */
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
