import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import test from "node:test";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const repositoryRoot = new URL("../../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repositoryRoot), "utf8"));
}

function gitBlobHash(content) {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}

function assertCoherentHunkOffsets(patch) {
  const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu;
  let accumulatedDelta = 0;
  let hunkCount = 0;

  for (const match of patch.matchAll(hunkPattern)) {
    const sourceStart = Number(match[1]);
    const sourceCount = Number(match[2] ?? 1);
    const targetStart = Number(match[3]);
    const targetCount = Number(match[4] ?? 1);
    assert.equal(
      targetStart,
      sourceStart + accumulatedDelta,
      `第 ${hunkCount + 1} 个 hunk 目标行号未累计前序偏移`,
    );
    accumulatedDelta += targetCount - sourceCount;
    hunkCount += 1;
  }

  assert.ok(hunkCount > 1, "ARMS patch 应包含多个连续 hunk");
}

test("ARMS patch 固定 0.0.3 且目标 blob 与安装产物一致", async () => {
  const [workspacePolicy, desktopManifest, npmrc, patch, installedEntry] = await Promise.all([
    readFile(new URL("pnpm-workspace.yaml", repositoryRoot), "utf8").then(parseYaml),
    readJson("packages/desktop/package.json"),
    readFile(new URL(".npmrc", repositoryRoot), "utf8"),
    readFile(new URL("patches/@arms__rum-electron@0.0.3.patch", repositoryRoot), "utf8"),
    readFile(new URL("node_modules/@arms/rum-electron/dist/index.mjs", repositoryRoot)),
  ]);

  assert.match(npmrc, /^node-linker=hoisted$/mu);

  const armsSpecifier = desktopManifest.dependencies?.["@arms/rum-electron"];
  assert.equal(armsSpecifier, "^0.0.3");
  const armsVersion = "0.0.3";
  assert.equal(
    workspacePolicy.patchedDependencies?.[`@arms/rum-electron@${armsVersion}`],
    `patches/@arms__rum-electron@${armsVersion}.patch`,
  );
  assert.equal(workspacePolicy.patchedDependencies?.["@arms/rum-electron@0.0.7"], undefined);

  // Bugfix：旧 patch 分次追加 hunk 后仍保留旧目标 hash，pnpm hoisted 第二次安装会误判并重复打补丁。
  const patchIndex = patch.match(/^index ([0-9a-f]{40})\.\.([0-9a-f]{40}) 100644$/mu);
  assert.ok(patchIndex, "patch 必须保留完整的 source/target blob hash");
  assertCoherentHunkOffsets(patch);
  assert.equal(gitBlobHash(installedEntry), patchIndex[2]);
});

const exec = promisify(execFile);
const sourceDirectory = fileURLToPath(new URL("packages/desktop/src/shared/", repositoryRoot));
const sourcePath = join(sourceDirectory, "armsRumShared.ts");
const jsPath = join(sourceDirectory, "armsRumShared.js");
const expectedCollectors = {
  perf: true,
  webvitals: true,
  exception: true,
  whiteScreen: true,
  api: true,
  staticResource: true,
  click: true,
  longTask: true,
};
const urlCases = [
  ["file:///Applications/UWork.app/renderer/index.html", "index"],
  ["file:///C:/Users/fixture/RESOURCE.HTML", "RESOURCE"],
  ["file:///tmp/", "index"],
  ["https://example.test/a/b?fixture=query#fragment", "/a/b"],
  ["https://example.test/", "/"],
  ["not a url", "not a url"],
  [`https://example.test/${"a".repeat(150)}`, `/${"a".repeat(119)}…`],
  ["x".repeat(150), `${"x".repeat(120)}…`],
];

async function runActualJavaScript(endpoint) {
  const root = await mkdtemp(join(tmpdir(), "uwork-arms-js-"));
  try {
    await mkdir(join(root, "node_modules", "@zcode", "shared"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    // 修复依据：普通 .js 导入可能回退到 TS；隔离包没有 TS 候选，Node 只执行真实产物字节。
    await copyFile(jsPath, join(root, "armsRumShared.js"));
    await writeFile(
      join(root, "node_modules/@zcode/shared/package.json"),
      '{"type":"module","exports":"./index.mjs"}',
    );
    await writeFile(
      join(root, "node_modules/@zcode/shared/index.mjs"),
      `
export const ZCODE_ARMS_RUM_ENDPOINT = process.env.ARMS_FIXTURE_ENDPOINT;
export const ZCODE_VERSION = "fixture-version";
export const mapZCodeEnvToArmsRumEnv = runtimeEnv => "mapped:" + runtimeEnv;
`,
    );
    await writeFile(
      join(root, "probe.mjs"),
      `
import * as module from "./armsRumShared.js";
const first = module.buildArmsBrowserInitConfig("development");
const second = module.buildArmsBrowserInitConfig("development");
const collectors = {...first.collectors};
first.collectors.click = false;
console.log(JSON.stringify({
  enable: first.enable, endpoint: first.endpoint, version: first.version, env: first.env,
  collectors, sessionConfig: first.sessionConfig, spaMode: first.spaMode,
  parserIdentity: first.parseViewName === module.parseArmsViewName,
  separateCollectors: first.collectors !== second.collectors,
  constantIntact: module.ARMS_BROWSER_COLLECTORS.click && second.collectors.click,
  names: ${JSON.stringify(urlCases.map(([url]) => url))}.map(module.parseArmsViewName),
}));
`,
    );
    const env = { ...process.env, ARMS_FIXTURE_ENDPOINT: endpoint };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await exec(process.execPath, [join(root, "probe.mjs")], { cwd: root, env });
    return JSON.parse(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function positionOf(text, token, after = 0) {
  const offset = text.indexOf(token, after);
  assert.ok(offset >= 0, `生成文本中缺少 ${token}`);
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1).length };
}

for (const endpoint of ["", "https://rum.example.test/ingest"]) {
  test(`真实 ARMS JS 按 endpoint ${endpoint || "(empty)"} 判定启用，保留 collectors 与页面名`, async () => {
    const result = await runActualJavaScript(endpoint);
    // 根因：旧 JS 将 enable 写死为 true；真实产物必须沿用当前 TS 的空 endpoint 关闭规则。
    assert.equal(result.enable, endpoint !== "");
    assert.equal(result.endpoint, endpoint);
    assert.equal(result.version, "fixture-version");
    assert.equal(result.env, "mapped:development");
    assert.deepEqual(result.collectors, expectedCollectors);
    assert.deepEqual(result.sessionConfig, { sampleRate: 1 });
    assert.equal(result.spaMode, false);
    assert.equal(result.parserIdentity, true);
    assert.equal(result.separateCollectors, true);
    assert.equal(result.constantIntact, true);
    assert.deepEqual(
      result.names,
      urlCases.map(([, name]) => name),
    );
  });
}

test("磁盘 ARMS JS 与当前 TS 的独立字符串编译结果一致", async () => {
  const [source, javascript] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(jsPath, "utf8"),
  ]);
  // 修复依据：仅使用根包声明的 TypeScript；独立字符串编译不能解析相邻 TS 来掩盖陈旧 JS。
  const options = {
    fileName: "armsRumShared.ts",
    compilerOptions: {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: true,
      sourceMap: false,
    },
    transformers: {
      after: [
        (context) => {
          const visit = (node) =>
            ts.isNamedImports(node)
              ? ts.factory.updateNamedImports(
                  node,
                  ts.factory.createNodeArray(node.elements, false),
                )
              : ts.visitEachChild(node, visit, context);
          // TypeScript 保留源码 import 尾逗号；统一该格式元数据，不更改运行时代码。
          return (node) => ts.visitNode(node, visit);
        },
      ],
    },
  };
  const expected = ts.transpileModule(source, options);
  const actual = ts.transpileModule(javascript, options);
  assert.equal(actual.outputText, expected.outputText);
});

test("ARMS 两个 source map 指回当前 TS，匹配最终生成文本行列", async () => {
  const source = await readFile(sourcePath, "utf8");
  for (const output of ["armsRumShared.js", "armsRumShared.d.ts"]) {
    const text = await readFile(join(sourceDirectory, output), "utf8");
    const rawMap = JSON.parse(await readFile(join(sourceDirectory, output + ".map"), "utf8"));
    assert.equal(rawMap.file, basename(output));
    assert.deepEqual(rawMap.sources, ["armsRumShared.ts"]);
    const map = new TraceMap(rawMap);
    for (const token of [
      "ARMS_BROWSER_COLLECTORS",
      "parseArmsViewName",
      "buildArmsBrowserInitConfig",
    ]) {
      const original = originalPositionFor(map, positionOf(text, token));
      assert.equal(original.source, "armsRumShared.ts");
      assert.notEqual(original.line, null);
      assert.notEqual(original.column, null);
      assert.ok(source.split("\n")[original.line - 1].slice(original.column).startsWith(token));
    }
    if (output.endsWith(".js")) {
      const token = "ZCODE_ARMS_RUM_ENDPOINT";
      const original = originalPositionFor(map, positionOf(text, token, text.indexOf("enable:")));
      assert.equal(original.source, "armsRumShared.ts");
      assert.equal(original.line, positionOf(source, token, source.indexOf("enable:")).line);
      assert.equal(original.column, positionOf(source, token, source.indexOf("enable:")).column);
    }
  }
});
