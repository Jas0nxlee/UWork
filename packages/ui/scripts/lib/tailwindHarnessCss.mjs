/**
 * 检查脚手架里的 **Tailwind 现场编译**（功能区布局检查与 PPT 画布检查共用）。
 *
 * 为什么需要它：检查页默认是**裸 HTML**（没有 Tailwind），组件里的 class 全部失效。
 * 这对"量真实高度/真实布局"的断言是致命的——功能区布局检查要量真实 flex 布局，
 * PPT 画布检查要证明"几何不靠 Tailwind 也成立、有 Tailwind 也不会错位"。
 * 做法：把 esbuild 打好的包当源码，抠出类名喂给 tailwindcss 编译器，产出 `harness.css`。
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** 检查页的主题（与编辑位的深色主题同色值；缺了颜色类就量不出真实观感）。 */
export const HARNESS_THEME_CSS = `@import "tailwindcss";
@theme {
  --color-background: #141414;
  --color-surface: #1f1f1f;
  --color-border: #3a3a3a;
  --color-foreground: #f2f2f2;
  --color-foreground-subtle: #b0b0b0;
  --color-foreground-subtlest: #808080;
}
body { margin: 0; background: #141414; color: #f2f2f2; font-family: system-ui, sans-serif; }
`;

/** 从打好的包里抠出候选类名喂给 tailwind（等价于 CLI 扫源码，省得维护 @source）。 */
export function candidatesFrom(bundle) {
  const tokens = new Set();
  for (const match of bundle.matchAll(/["'`]([^"'`\n]{1,400})["'`]/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (/^-?[a-z@![]/i.test(token) && /^[-\w@!:./[\]%(),#]+$/.test(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

/** 生成 `harness.css` 到检查目录（页面用 `<link rel="stylesheet" href="/harness.css">` 引它）。 */
export async function emitTailwindCss(options) {
  const { dir, bundle, repoRoot } = options;
  const themeCss = options.themeCss ?? HARNESS_THEME_CSS;
  const { compile } = await import("tailwindcss");
  const loadStylesheet = async (id, base) => {
    const path =
      id === "tailwindcss"
        ? join(repoRoot, "node_modules/tailwindcss/index.css")
        : resolve(base, id);
    return { path, base: dirname(path), content: await readFile(path, "utf8") };
  };
  const compiler = await compile(themeCss, { base: repoRoot, loadStylesheet });
  const css = compiler.build(candidatesFrom(bundle));
  await (await import("node:fs/promises")).writeFile(join(dir, "harness.css"), css, "utf8");
}
