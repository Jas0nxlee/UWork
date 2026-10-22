# model-preview

只读 3D 预览。宿主传入字节、同目录资源读取端口、文案和主题，viewer 独占解析结果、
相机和 GPU 生命周期；卸载释放资源。模型不进入上传 manifest，不另建文件读取服务。

公开 contract 只描述数据和文件端口，不加载 three。格式识别、labels hook、懒加载入口和
viewer 是集成入口；内部 loader、资源路径策略和 scene 不对其它业务模块开放。

格式识别与宿主注入示例由 contract.test.ts 验证；安全路径、场景释放及侧栏保持挂载的
回归仍在 packages/ui/test/modelPreview.test.ts 等既有测试中。
