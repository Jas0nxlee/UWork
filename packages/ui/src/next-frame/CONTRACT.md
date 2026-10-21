# next-frame

共享 UI 单次帧调度，不持有业务状态；公开入口保持 `lib/nextFrame.ts`。
每次调用的闭包独占 done 状态，rAF 和备用定时器只竞争同一次提交。
隐藏页面同步执行，取消函数幂等。类型契约与示例描述既有行为，DOM 与时间 IO 位于 adapter。
规格：`specs/next-frame-scheduling.md`；完整运行回归：`test/nextFrame.test.ts`。
