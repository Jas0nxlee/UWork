import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const t0 = Date.now();
const dir = mkdtempSync(join(tmpdir(), "probe-esb-"));
const entry = join(dir, "entry.tsx");
writeFileSync(entry, `import ExcelJS from "exceljs";\nimport { Workbook } from "@fortune-sheet/react";\nconsole.log(typeof ExcelJS, typeof Workbook);\n`, "utf8");
console.log("entry written", Date.now() - t0);
const esbuild = await import("esbuild");
console.log("esbuild imported", Date.now() - t0);
const result = await esbuild.build({
  entryPoints: { excel: entry },
  outdir: dir,
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  nodePaths: [join(process.cwd(), "../../node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log("built", Date.now() - t0, result.outputFiles.map((f) => f.path));
