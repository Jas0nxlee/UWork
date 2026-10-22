# im-service

现有 `IImService` 是消息视图、缓存、连接及补洞编排的唯一宿主服务，服务端仍是消息与权限真相来源。

契约按会话、时间线、消息附加操作与汇报四组能力拆分，保留同一个 `IImService` 描述符、方法名、
参数和 RPC 通道。视图和事件单独定义，不新增运行时对象或通信路径。

公开 contract.ts；宿主装配另使用 imService.ts、imHttpClient.ts。其余缓存、摘要和 socket 编排是内部实现。
contract.example.ts / contract.test.ts 验证只读初始视图不联网，也不将未知准入误报为拒绝。
既有 test/im\*.test.ts 覆盖重连、幂等发送、补洞与未读行为。
