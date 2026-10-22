import { defineConfig } from "tsup";

// relay 是独立部署的服务：构建产物要自带协议依赖与 ws，
// 运行阶段只有一个 js 文件 + node（见 specs/web-remote-control-relay.md 第八节）。
export default defineConfig({
  entry: { entry: "src/entry.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ["@zcode/shared", "ws"],
  // ws（CJS）内部用动态 require 拿 node:events/node:stream，直接内联进 ESM 会抛
  // 「Dynamic require of "events" is not supported」。这里补一个 createRequire 垫片，
  // 换来「产物只有一个 js 文件、运行期不需要 node_modules」的部署形态。
  banner: {
    js: "import { createRequire as __relayCreateRequire } from 'node:module'; const require = __relayCreateRequire(import.meta.url);",
  },
});
