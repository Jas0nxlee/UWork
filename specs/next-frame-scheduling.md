# UI 帧调度边界

`runOnNextFrame` 是应用外壳、toast、头像及侧栏共享的单次调度入口。
本次登记 `next-frame` managed 模块，覆盖既有 `lib/nextFrame.ts` 与契约目录；不改变调度行为。

- 隐藏页面同步执行；可见页面使用 rAF 与 250ms 备用定时器，最先到达者只执行一次。
- 返回的取消函数取消两条路径；已完成后的重复取消不重新触发回调。
- 单次调用闭包唯一持有 done 状态；调用方不另设补偿定时器或保存派生队列。
- 无 rAF 的环境使用同一个定时器分支；平台 DOM/时间操作留在 adapters 层。
- 入口保留 `packages/ui/src/lib/nextFrame.ts`，既有调用方无需修改。

```text
调用 → 单次调度闭包(done=false) → rAF 或 timer → done=true → callback 一次
                              └→ cancel → done=true → 取消两条路径
```

验收沿用 `packages/ui/test/nextFrame.test.ts`（隐藏、可见、竞速、取消、无 rAF），
另由 contract.test 验证真实调度器经公开签名和示例传入时的行为。
