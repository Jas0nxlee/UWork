/**
 * im-ui 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const imUiModule = {
  id: "im-ui",
  requires: ["services", "shared", "ui"],
  provides: ["im-ui"],
  publicEntrypoints: [
    "contract.ts",
    "MessagesSidePane.tsx",
    "useImSidebar.ts",
    "useImNotifications.ts",
  ],
} as const;
