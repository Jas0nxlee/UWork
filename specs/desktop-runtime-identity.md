# 桌面运行时进程与 Linux 桌面项身份

- Shared 的进程命名契约唯一决定当前 `uwork-host-*`、`uwork-agent-*` 名称。Desktop 遥测按该契约分类，同时兼容改名前的 `zcode-host-*`、`zcode-agent-*`；只有完整角色段匹配，普通 Chromium Utility 不计入崩溃。
- Linux 用户级 `zcode.desktop` 的归属只依据本应用已写入的精确 Comment 行，接受现行 `Comment=UWork Desktop App` 与历史 `Comment=ZCode Desktop App`。有系统级条目时清理两种已归属用户级条目，保留没有归属标记的用户自建文件。
- 进程角色分类由 Shared 纯函数拥有；崩溃上报由 Desktop 拥有。桌面项文件检查和删除由 Desktop Main 拥有。
- 验收：新旧 Host/Agent 异常退出计入正确角色；Utility 不计入；Linux 老标记条目被清理，新标记照常清理，自建条目保留。
