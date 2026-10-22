# im-protocol

IM 消息、实时帧和数据卡片的共同协议。既有 im.ts / imCard.ts 保持唯一实现，
此模块登记其边界并提供聚合契约，不复制协议，不依赖 IO、React 或宿主服务。

公开 contract.ts 与原有 im.ts / imCard.ts 入口，保持 @zcode/shared 的导出兼容。
帧使用运行时 schema 校验；卡片只允许数据原语且必须有 fallback，权限仍由服务端判定。
contract.test.ts 用真实解析器验证标准卡片、缺 fallback 和未知帧的边界。
