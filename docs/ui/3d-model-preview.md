# 3D 模型预览

## 这份 spec 的范围

一句话：**能在界内把 3D 模型转着看**。刻意做小——只读预览、轨道相机、自动取景、一行模型信息、重置视角。
不做编辑、导出、格式转换、动画播放、线框/网格开关、统计面板，也没有为 3D 单独造文件读取通道。

| 字段       | 内容                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 变更       | Preview Pane 新增 3D 模型只读预览：`.glb`、`.gltf`、`.obj`、`.stl`、`.ply`、`.3mf`                      |
| 用户入口   | 工作区文件树、文件链接、工具调用预览卡，以及**对话里提到模型文件时的预览卡片**（任何 `CodeViewerSource` 入口都自动生效） |
| 渲染库     | `three`（MIT，WebGL2）+ `three/examples/jsm` 官方 loader，按格式懒加载                                    |
| 字节来源   | 复用只读 Office 预览的 `fileService.readBinaryPreview` 通道（25 MB 上限 + base64），**不新增读取通道**     |
| 状态所有者 | 解析与相机状态由当前 Preview Pane 的 viewer 持有；不持久化、不进消息流                                    |

## 支持范围与边界

| 扩展名   | 解析器                    | 说明                                              |
| -------- | ------------------------- | ------------------------------------------------- |
| `.glb`   | `GLTFLoader`              | 自包含二进制 glTF（也按内容识别，不认扩展名）      |
| `.gltf`  | `GLTFLoader`              | JSON + 同级 `.bin`/贴图，按模型目录解析            |
| `.obj`   | `OBJLoader` + `MTLLoader` | 同级 `mtllib` 与 MTL 里的贴图一并解析              |
| `.stl`   | `STLLoader`               | 二进制与 ASCII 都支持                              |
| `.ply`   | `PLYLoader`               | 有面片按三角面渲染；没有 `element face` 时按点渲染 |
| `.3mf`   | `3MFLoader`               | 3D 打印交换格式（ZIP + XML）                       |

- **`.fbx` / `.dae` / `.usdz` / `.blend` / CAD（`.step`/`.iges`）不在范围内**：前几类没有明确场景，CAD 需要额外
  的 OpenCascade WASM。它们继续按普通文件预览。
- **Draco / KTX2 / meshopt 压缩的 glTF 不静默失败**：读到 `extensionsRequired` 里含这些扩展时直接给出可读文案
  （"使用了压缩扩展…可先转成未压缩的 .glb"），而不是渲染成一片空白。
- **对话卡片**：正文里提到 `.glb/.gltf/.obj/.stl/.ply/.3mf` 时生成可点开的「3D 模型」卡片（`assistantFileReferences` +
  shared 候选表）。3D 与视频/音频一样是**预览卡片专用类型**：`ConversationArtifactType` 里没有这些枚举，
  分享 manifest 的 `matchAllowedArtifact` 会把它们挡在可上传清单之外。
- **不受信任内容的收口**：模型文件与 Office 文档同级。外部资源只按**同级目录的相对路径**解析，
  `http(s)://` 一律不抓（打开本地模型不能成为出网通道），`..` 上跳一律拒绝；读不到的贴图退化成透明占位，
  读不到的 `.bin`（几何就在里面）直接报错。

## 实现契约

- 扩展名识别在 `packages/ui/src/lib/modelPreview.ts`；不得混进 `getOfficeFilePreviewKind`。
- 路由用独立 resolver（`resolvePreviewPaneModelSource`）：`type: "file"` + 扩展名升级成 `type: "model"`，
  与 PDF/PPTX 同一策略；`CodeViewerSource` 新增 `ModelCodeViewerSource` 后必须同步 `getCodeViewerTabSourceKey`，
  否则同一文件会分裂成两个 tab。
- `fileSource` 门控必须排除 model source（否则 `.glb` 会先被当文本读成"二进制内容"）；
  `isPlainCodeSource` 对模型返回 `false`（没有源码视图，也不该出现自动换行开关）。
- 字节读取复用 `readBinaryPreview`；`three` 与各 loader 必须动态 `import()`（viewer 懒加载），主包零增量。
- 卸载必须显式释放：几何/材质/贴图/`renderer`/`controls`/`ResizeObserver`，并处理 `webglcontextlost`（换一块新画布重建场景）。
- 渲染**按需**：首帧、容器尺寸变化、模型变化各一帧；OrbitControls 在 three 里只在调用 `update()` 时才移动相机，
  所以**交互期间与松手后 400ms 的阻尼回稳期**要跑帧循环，其余时间不得常驻 `requestAnimationFrame`。
- 画布背景来自容器 CSS 语义 token（画布 `alpha: true`）；场景内网格颜色按 `resolvedTheme` 取固定中性常量
  （WebGL 读不到 CSS 变量）。新增样式只用 `DESIGN.md` 语义 token。
- 新扩展名必须补 `fileDisplayHelpers` 的图标别名（`glb/gltf/obj/stl/ply/3mf → 3d`），否则图标 404 退化成通用文档图标。
- 文案同时进 `zh-CN` 与 `en-US`；错误日志统一走 `packages/ui/src/logger.ts`。

## 验收场景

| ID     | 场景                                        | 预期                                                       | 自动化状态 |
| ------ | ------------------------------------------- | ---------------------------------------------------------- | ---------- |
| MOD-01 | 打开 `.glb`（含贴图）                       | 自动取景显示模型，一行信息给出三角面数与包围盒尺寸          | covered    |
| MOD-02 | 打开二进制 `.stl`                           | 与 glb 同一路径渲染，面数一致                               | covered    |
| MOD-03 | 拖拽 / 滚轮                                 | 视角跟随；阻尼回稳后静止                                     | covered    |
| MOD-04 | 点"重置视角"                                | 回到自动取景（不受刚才拖拽的惯性影响）                       | covered    |
| MOD-05 | 打开损坏 / 非模型字节                       | 本地化错误态，可读文案，不影响其它 tab                       | covered    |
| MOD-06 | Draco 压缩的 glTF                           | 明确提示使用了压缩扩展                                       | unit       |
| MOD-07 | `.gltf` 引用 `https://…` 贴图 / `../` 上跳  | 不发请求 / 拒绝该引用；几何照常渲染，贴图退化为透明占位       | unit       |
| MOD-08 | `.gltf` 的 `.bin` 读不到                    | 报错（不假装能渲染），文案指出是哪个文件                     | unit       |
| MOD-09 | 同一文件从文件树与模型入口分别打开           | 复用同一个 tab                                              | unit       |
| MOD-10 | 手机窄屏 / 窄侧栏                           | 画布铺满容器，模型按较小视野取景不裁切                       | 人工       |
| MOD-11 | 文件超过 25 MB                              | 复用 Office 通道的超限文案                                  | unit       |

## 真机验收（2026-10-19，dev 应用）

在重建后的 dev 应用里走通了完整用户路径（`~/.uwork/workspace/default` 是隐藏目录、文件树进不去，
正好用这条路径验收）：

1. 新建任务 → 在会话里要求 agent 列出 `/Users/xin/Desktop/UWork-3D-Demo` 下的模型路径（该目录是样例的可见副本）；
2. agent 回复绝对路径后，对话里出现四张「3D 模型」卡片（`.glb`/`.ply`/`.obj`/`.stl`；`.mtl` 按预期不出卡片）；
3. 点卡片 → 右侧预览打开 `torus-knot.glb`：`data-model-preview-state=ready`、画布 1554×2138 已渲染、
   信息行为「15,360 三角面 · 6.04 × 6.34 × 2.68」、重置按钮存在；截图里对方结的金属质感、光照与地面网格都正常。

（样例是现场生成的：`torus-knot.glb` 金属结 15,360 面、`hex-washer.stl` 二进制垫圈 384 面、
`sphere-points.ply` 4,000 点彩色点云、`pyramid.obj`+`.mtl` 四色四棱锥。）

## 验证记录（2026-10-19）

- **单测**（34 条，全绿）：`modelPreview.test.ts` 31 条（扩展名识别含伪装后缀、同级资源路径解析与
  协议/上跳拒绝、失败文案归类）；`previewPaneModelContent.test.ts` 3 条（加载态、读取失败态、
  无 WebGL 环境下给可读错误态而不是崩溃）。另在既有文件里增补路由与身份断言：`previewPane.test.ts`
  4 条（分隔线、resolver 升级、伪装后缀拒绝、不进代码视图）、`workspaceSidePane.test.ts` 2 条
  （同一文件两个入口复用同一 tab）、`previewPaneI18n.test.ts` 1 组中英成对文案、
  `animatedSidePanePanelLayout.test.ts` 1 条（resize 期间保持挂载）。
- **真渲染冒烟**：`pnpm --filter @zcode/ui check:model-preview`（单文件自包含：现场生成带贴图的
  `.glb` 与二进制 `.stl`，无头 Chromium + 真 WebGL，截图后把像素丢回页面里用 2D canvas 取数）。
  9 条断言全绿：解析出 12 三角面 / 2×2×2 包围盒、非背景像素占比 0.59、偏蓝像素占比 0.58
  （贴图生效）、拖拽后画面差异 0.152、重置后差异 0.000、损坏字节进入错误态、整轮无页面报错。
- **该冒烟在开发中抓到一个真 bug**：只做"按需渲染"时 OrbitControls 永远不移动相机——three 只在
  `update()` 里把拖拽累积量写进相机，而它的 `change` 事件本身是 `update()` 派发的，形成死循环。
  现在在交互期间与松手后 400ms 的阻尼回稳期跑帧循环，其余时间不渲染。
- **类型检查**：`pnpm exec tsc --noEmit -p packages/ui/tsconfig.json` 通过。
- **格式与静态检查**：`oxfmt --check` 与 `oxlint` 对本改动涉及的文件通过。
- **未执行**：`pnpm lint` / `pnpm fmt:check` 全仓（本机工作树里另有其它会话在途改动，只对本次改动涉及的文件
  跑了 oxlint/oxfmt）；office 门禁 `check:office`（本机 playwright 管理的浏览器 revision 不匹配、下载又被
  仓库补丁拦住，属环境问题，与本次改动无关）。真机验收见上一节。
- **对话卡片（2026-10-19 追加）**：正文提到模型路径时出可点开的「3D 模型」卡片。改动面：UI 的
  `assistantFileReferences`（kind/表/两条正则）、shared 的 `conversation-preview-artifacts`（kind/候选表/正则）、
  services 的分享清单守卫（把 model 与视频/音频一起排除在可上传 manifest 之外）、中英文案
  `chat.previewCards.model`；测试补 `assistantPreviewCards.test.ts`（提到 glb/stl 出两张 model 卡片、
  点开落到 `{type:"file"}`）与 shared `conversationPreviewArtifacts.test.ts`（候选 kind/artifactType）。
  `packages/services/test/conversationShare*.test.ts` 161 条与卡片相关测试 62 条全绿。
- **未纳入本版**：`.gltf` 同级资源之外的形式（Draco/KTX2）、动画播放、文件被覆写后自动刷新。
  前两项在 `渲染库`/`格式范围` 里写明为不做。
