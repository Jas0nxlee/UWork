/**
 * im-service 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const imServiceModule = {
  id: "im-service",
  requires: ["rpc", "services", "shared"],
  provides: ["im-service"],
  publicEntrypoints: ["contract.ts", "imService.ts", "imHttpClient.ts"],
} as const;
