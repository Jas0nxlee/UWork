// @vitest-environment node
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 部门台账导出**必须在"已安装技能目录"里也能跑**。
 *
 * 真机踩到：脚本 `import "exceljs"` 只在仓库里能解析（monorepo 的 node_modules 兜住了），
 * 而 agent 是在用户技能根（`~/.uwork/skills/...`，**没有 node_modules**）里运行它的
 * ——负责人要导出部门台账，脚本直接 `ERR_MODULE_NOT_FOUND`。
 *
 * 所以这条测试**故意把技能包拷到临时目录再跑**（复现安装后的条件），并检查产出是合法 xlsx。
 */
const REPO_ROOT = join(import.meta.dirname, "../../..");
const SKILL_DIR = join(REPO_ROOT, "skills/dept-qa-report");

describe("部门台账导出（零依赖）", () => {
  it("技能包被拷到没有 node_modules 的目录后，导出仍然产出合法 xlsx（表头来自 export.columns.json）", () => {
    const workdir = mkdtempSync(join(tmpdir(), "skill-install-"));
    const installed = join(workdir, "dept-qa-report");
    cpSync(SKILL_DIR, installed, { recursive: true });
    const itemsPath = join(workdir, "items.json");
    writeFileSync(
      itemsPath,
      JSON.stringify([
        {
          title: "一条记录",
          periodKey: "2026-10",
          content: "正文",
          fields: { 测试方式: "AI测试", 测试数量: 3 },
        },
      ]),
      "utf8",
    );
    const outPath = join(workdir, "out.xlsx");

    const stdout = execFileSync(
      process.execPath,
      [join(installed, "scripts/export-ledger.mjs"), "--from", itemsPath, "--out", outPath],
      { encoding: "utf8" },
    );
    expect(stdout).toContain("导出 1 行");

    // xlsx = zip；条目不压缩存放，所以能直接在字节里找 XML 片段（不引第三方解压库）
    const bytes = readFileSync(outPath);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const text = bytes.toString("utf8");
    expect(text).toContain("xl/worksheets/sheet1.xml");
    const columns = JSON.parse(readFileSync(join(SKILL_DIR, "export.columns.json"), "utf8")) as {
      columns: { header: string }[];
    };
    expect(text).toContain(columns.columns[0]!.header);
    // 数值列写成数值（Excel 里能求和），不是文本
    expect(text).toContain(`<v>3</v>`);
  });

  it("技能包里不许出现裸包导入（只有相对路径与 node: 内置模块）", () => {
    const scripts = [
      "export-ledger.mjs",
      "submit-work-item.mjs",
      "render-card.mjs",
      "rollup-scope.mjs",
      "xlsx-lite.mjs",
    ];
    for (const script of scripts) {
      const source = readFileSync(join(SKILL_DIR, "scripts", script), "utf8");
      const imports = [...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map(
        (match) => match[1]!,
      );
      for (const specifier of imports) {
        const ok = specifier.startsWith(".") || specifier.startsWith("node:");
        expect({ script, specifier, ok }).toEqual({ script, specifier, ok: true });
      }
    }
  });
});
