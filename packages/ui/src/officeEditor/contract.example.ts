import type { OfficeEditorFilePort, OfficeEditorPaneProps } from "./contract.js";

/** 宿主传入当前工作区的文件端口；切换/退出前使用派生脏标记提示未保存内容。 */
export function exampleOfficeEditorProps(
  fileService: OfficeEditorFilePort,
  path: string,
  onDirtyChange: NonNullable<OfficeEditorPaneProps["onDirtyChange"]>,
): OfficeEditorPaneProps {
  return { fileService, path, onDirtyChange };
}
