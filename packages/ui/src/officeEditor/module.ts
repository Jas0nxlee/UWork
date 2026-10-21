/** 文件端口由宿主注入；与 architecture-policy.yaml 保持一致。 */
export const officeEditorModule = {
  id: "office-editor",
  requires: ["ui", "services"],
  provides: ["office-editor"],
  publicEntrypoints: [
    "contract.ts",
    "CanvasOfficeEditorPane.tsx",
    "ExcelEditorPane.tsx",
    "PptxEditorPane.tsx",
  ],
} as const;
