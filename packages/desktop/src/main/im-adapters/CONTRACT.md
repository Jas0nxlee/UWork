# desktop-im

Main 的 IM 适配：附件写入下载目录，以及任务/消息未读合并后的系统角标。
附件使用异步文件 IO、文件名清洗与独占创建，重复保存不覆盖；角标仍只有 appBadge 一个写入点。

公开 contract.ts、既有 appBadge.ts 与 imAttachmentFile.ts；不接管消息、会话或连接状态。
既有 unreadBadge.ts 保持通用平台计算工具，通过 desktop 模块依赖使用。
contract.test.ts 验证文件名与重复下载；appBadgeCount.test.ts 继续验证计数边界。
