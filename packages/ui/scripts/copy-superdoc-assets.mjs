/**
 * 把 SuperDoc 引擎资产从 node_modules 原样搬到 public/superdoc/（Vite 会按静态文件托管，不做转换）。
 *
 * 为什么必须"原样"：dev server 直接经 /@fs/ 引用 node_modules 里的 worker 文件时，Vite 会把它当源码
 * 处理（内联 sourcemap），10.6 MB 变成 48.6 MB，module worker 起不来 —— 真机报 "worker not start"。
 * 静态托管后浏览器拿到的是压缩产物本身，worker 正常启动。
 *
 * 用法：node packages/ui/scripts/copy-superdoc-assets.mjs（dev/build 前跑一次即可；已是最新则跳过）
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const source = join(repoRoot, "node_modules/@superdoc/docx-engine/dist-cdn");
// 渲染进程 Vite 的 root 是 packages/desktop/src/renderer（见 packages/desktop/vite.config.ts:185），
// 所以 publicDir 就是它下面的 public/ —— 资产必须放这里才会按静态文件托管。
const target = join(repoRoot, "packages/desktop/src/renderer/public/superdoc/dist-cdn");

async function isUpToDate() {
  try {
    const [a, b] = await Promise.all([readdir(source), readdir(target)]);
    if (a.length !== b.length) return false;
    for (const name of a) {
      const [sa, sb] = await Promise.all([stat(join(source, name)), stat(join(target, name))]);
      if (sa.size !== sb.size) return false;
    }
    return true;
  } catch {
    return false;
  }
}

if (await isUpToDate()) {
  console.log("[superdoc-assets] 已是最新，跳过");
} else {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  const entries = await readdir(target, { withFileTypes: true });
  const assets = entries.find((entry) => entry.name === "assets");
  console.log(
    `[superdoc-assets] 已同步 ${entries.length} 个条目${assets ? "（含 assets/ worker）" : ""} → ${target}`,
  );
}
