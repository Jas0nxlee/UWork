# office-editor

将 DOCX/XLSX/PPTX 的编辑引擎、草稿和格式安全检查限制在同一个 UI 模块。
公开调用面为三个 Pane 与 `OfficeEditorPaneProps`，PreviewPane 注入最小文件端口。

- 文档 hook 是草稿、revision、保存基线的唯一 owner；dirty 回调只供外壳离开确认。
- 文件事实仍由 IFileService 管理。编辑器不直接调用具体 Service/Repo，不增加持久状态副本。
- 显式保存先导出、校验，再经 writeBinaryFile 做版本比对、sibling 备份和写回。
- 护栏失败及版本冲突均不得当作保存成功；成功后才推进基线并清除脏标记。
- 远端复用宿主提供的端口；没有二进制写回能力时保持只读，不另建远端写入路径。
- renderer 的格式校验与引擎适配是内部实现，跨模块只通过三个面板入口进入。

细节和验收：`specs/office-editor-in-core.md`；契约测试运行真实格式校验与保存流水线。
