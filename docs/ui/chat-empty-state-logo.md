# New Task Empty State Logo

## 背景

New Task 的空状态标题是用户进入项目后开始创建任务的首屏提示。UWork 首页背景使用 UCAS，具体品牌规则见 [UWork 品牌替换](../../specs/uwork-branding.md)。

## 方案

- `ConversationDraftEmptyState` 在问候语背后展示装饰性 UCAS SVG。浅色使用继承 `foreground-subtlest` 的文字与 `opacity-70`，深色使用 `assets/UCAS.svg` 内置的弱化渐变，两套标识互斥显示。
- 外层容器固定 `36:11` 比例，宽度为 `min(76vw, 52rem)`，桌面最大 832px，移动端随视口收缩。
- 公共容器通过标准 CSS mask 和 `-webkit-mask-image` 从高度 `45%` 开始渐隐，在 `85%` 处完全透明；相对标题中心上移 `-mt-20`，保持既有布局。
- Logo 使用 `aria-hidden` 和 `pointer-events-none`，不参与可访问性朗读，也不拦截输入。
- 问候语继续由现有组件按时间与可用宽度显示，文本层级高于背景，手机远控保留紧凑标题。
