/**
 * im-protocol 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const imProtocolModule = {
  id: "im-protocol",
  requires: [],
  provides: ["im-protocol"],
  publicEntrypoints: ["contract.ts", "../im.ts", "../imCard.ts"],
} as const;
