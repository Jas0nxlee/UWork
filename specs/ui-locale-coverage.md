# UI 语言包覆盖与远程用语

## 2026-10-21 词条修复范围

中文和英文的可见消息由既有 `i18n/locales/zh-CN.ts` 与 `en-US.ts` 提供；本次只修复词条覆盖与措辞，继续使用当前消息 ID 和格式化规则。

- 插件市场已有 `settings.plugins.marketplace.recommendTitle` 英文 ID，中文必须提供“推荐”，沿用 `CONTEXT.md` 的 Recommended 术语。
- WSL 连接说明使用“Linux 发行版 / Linux distribution”，说明可以连接默认项或选择已安装项。
- Docker 连接说明只说明可以连接这台设备上的容器；执行命令属于实现细节，界面不展示 `docker exec` 或 `docker cp`。
- 远程词表继续遵守 [远程连接术语合同](../docs/issues/remote-connection-ux/03-presentation-model-states-and-glossary.md)，中英文均不出现禁用工程术语。
- 工作流 `chat.toolCall.workflow.run.*`、`chat.toolCall.workflow.settingsChange.*` 和 `chat.workflowLaunch.settings*` 的已有词条在两种语言中保持同集同序；现有 `{n}` 等占位符保持一致。
- 补齐 `settings.limit.ceiling`、`settings.limit.atCeiling`、`settingsChange.limitCeiling`、`settings.machineLimit` 与 `settings.machineLimitValue` 五个已有兼容 ID 的英文翻译。现有工作流默认并发与本次运行上限的行为仍遵守 [运行展示合同](../docs/dynamic-workflow/presentation.md#the-settings-popover)。
- 手机首页继续使用现有 UWork 品牌词条。

验收沿用 `remoteConnectionGlossary.test.ts`、`webRemoteControlUworkLocale.test.ts`、`workflowRunDigest.test.ts` 和 `workflowRunSettings.test.ts` 的完整断言；四个文件均实际执行，词条缺失不以英文 fallback 代替覆盖。

## 回归证据

本次工作树聚焦复现四文件 91 项：修复前 5 项失败、86 项通过，失败分别为两种语言的远程禁用词、推荐标题中文缺失及两组工作流键集差异。
原始合并基线 b1fb 的统一复现也包含这些既有失败。修复词条后四文件 91/91 通过，原测试断言保持原样。
工作流词表按完整前缀检查，包含首次失败输出未继续展示的 machineLimit 与 machineLimitValue 两条兼容消息。
