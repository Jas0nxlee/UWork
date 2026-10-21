import type { IFileService } from "@zcode/services";

/** 文件事实由现有文件服务持有；编辑器只经宿主注入的最小端口读写。 */
export type OfficeEditorFilePort = Pick<
  IFileService,
  "readBinaryPreview" | "stat" | "writeBinaryFile"
>;

/** 三种 Office 面板共享的真实调用契约，不暴露具体引擎或内部草稿。 */
export interface OfficeEditorPaneProps {
  fileService: OfficeEditorFilePort;
  path: string;
  /** 远端载入前验证写回能力，保持旧服务端的只读边界。 */
  remote?: boolean;
  /** 只报告脏标记；草稿、保存基线与 revision 仍由文档 hook 唯一持有。 */
  onDirtyChange?: (dirty: boolean) => void;
  onExit?: () => void;
}
