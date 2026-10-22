/**
 * model-preview 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const modelPreviewModule = {
  id: "model-preview",
  requires: ["ui"],
  provides: ["model-preview"],
  publicEntrypoints: [
    "contract.ts",
    "ModelPreviewViewer.tsx",
    "../hooks/useModelViewerLabels.ts",
    "../lib/modelPreview.ts",
    "../previewPaneModelContent.tsx",
  ],
} as const;
