export type IdentityIssuerDiagnostic =
  | {
      reason: "http-rejected";
      status: number;
      category: "organization" | "authorization-code" | "permission" | "unknown";
    }
  | { reason: "response-schema"; fields: string[] }
  | {
      reason:
        | "response-body"
        | "additional-verification"
        | "token-format"
        | "token-expiry-claim"
        | "token-expired"
        | "network-failed"
        | "identity-changed";
    };

const responseFields = new Set([
  "token",
  "user",
  "user.id",
  "user.org_id",
  "user.name",
  "needsEmailAuth",
]);

/** 认证错误可能夹带凭据和用户资料；仅固定分类和已知字段路径允许进入日志。 */
export function createIdentityIssuerDiagnostics(sink: (event: IdentityIssuerDiagnostic) => void) {
  return {
    http(status: number, body: unknown) {
      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const message = [record.error, record.message]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .slice(0, 4096)
        .toLowerCase();
      const category = /org.*not.*found|organization.*not.*found/.test(message)
        ? "organization"
        : /invalid.*code|code.*(?:used|expired|invalid)|40029|40163/.test(message) ||
            record.errcode === 40029 ||
            record.errcode === 40163
          ? "authorization-code"
          : status === 401 || status === 403
            ? "permission"
            : "unknown";
      sink({ reason: "http-rejected", status, category });
    },
    schema(paths: string[]) {
      sink({
        reason: "response-schema",
        fields: [...new Set(paths.filter((path) => responseFields.has(path)))],
      });
    },
    failure(
      reason: Exclude<IdentityIssuerDiagnostic["reason"], "http-rejected" | "response-schema">,
    ) {
      sink({ reason });
    },
  };
}
