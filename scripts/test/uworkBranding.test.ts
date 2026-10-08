import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, posix, resolve, win32 } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { buildCliPrefixSection } from "../../apps/zcode-cli/packages/core/src/context/sections/cli-prefix.js";
import {
  buildIdentitySection,
  buildSecurityNotice,
} from "../../apps/zcode-cli/packages/core/src/context/sections/identity.js";
import { buildDesktopContextSection } from "../../apps/zcode-cli/packages/core/src/context/sections/desktop.js";
import { buildGeneralPurposeSystemPrompt } from "../../apps/zcode-cli/packages/core/src/subagent/general-purpose.js";
import { buildExploreAgentPrompt } from "../../apps/zcode-cli/packages/core/src/subagent/explore.js";
import { resolveZCodeBuiltinPromptCommand } from "../../apps/zcode-cli/packages/bootstrap/src/builtin-prompt-command.js";
import { buildZCodeSourceHeadersFromContext } from "../../packages/shared/src/zcode-source-headers.js";
import { withOpenRouterAttributionHeaders } from "../../packages/shared/src/openrouter-attribution.js";
import {
  getDesktopMenuMessage,
  desktopMenuMessageIds,
} from "../../packages/shared/src/desktopMenu.js";

test("default and styled model contexts identify UWork and retain security guidance", () => {
  const sections = [buildCliPrefixSection(), buildIdentitySection(), buildDesktopContextSection()];
  for (const section of sections) {
    assert.match(section.content, /UWork/);
    assert.doesNotMatch(section.content, /\bZCode\b/);
    assert.equal(section.chars, section.content.length);
  }
  assert.ok(sections[1]!.content.includes(buildSecurityNotice()));
  const styled = buildIdentitySection({ name: "fixture", prompt: "fixture" });
  assert.match(styled.content, /UWork's tools/);
  assert.ok(styled.content.includes(buildSecurityNotice()));
});

test("subagent prompts use UWork without weakening their task constraints", () => {
  assert.match(buildGeneralPurposeSystemPrompt(), /UWork CLI/);
  const explore = buildExploreAgentPrompt({ embeddedSearchEnabled: true });
  assert.match(explore, /UWork Explore/);
  assert.match(explore, /READ-ONLY MODE/);
  assert.doesNotMatch(explore, /\bZCode\b/);
});

test("init branding preserves actual instruction paths and user instructions", () => {
  const prompt = resolveZCodeBuiltinPromptCommand("/init keep fixture instruction", {
    workingDirectory: "/tmp/workspace-fixture",
  })!;
  assert.match(prompt, /UWork's built-in \/init/);
  assert.match(prompt, /future UWork agents/);
  assert.ok(prompt.includes(".zcode/AGENTS.md"));
  assert.ok(prompt.includes("keep fixture instruction"));
  assert.equal(resolveZCodeBuiltinPromptCommand("/not-init"), undefined);
});

test("source attribution changes display values while keeping protocol header keys", () => {
  const headers = buildZCodeSourceHeadersFromContext({
    appVersion: "3.14.4",
    sourceTitle: "desktop",
    endpointOrigin: "https://service.example",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(headers["User-Agent"], "UWork/3.14.4");
  assert.equal(headers["X-Title"], "UWork@desktop");
  assert.equal(headers["X-ZCode-App-Version"], "3.14.4");
  assert.equal(headers["HTTP-Referer"], "https://service.example");
  assert.equal(
    withOpenRouterAttributionHeaders(headers, "https://openrouter.ai/api/v1")["X-OpenRouter-Title"],
    "UWork",
  );
});

test("native menu branding preserves compatible helper filenames", async () => {
  assert.equal(getDesktopMenuMessage("zh-CN", desktopMenuMessageIds.helpAbout), "关于 UWork");
  const helper = await readFile(resolve("packages/zcode-cua/broker-helper-constants.js"), "utf8");
  assert.match(helper, /HELPER_DISPLAY_NAME = "UWork Computer Use"/);
  assert.match(helper, /HELPER_APP_NAME = "ZCode Computer Use.app"/);
});

async function loadDesktopPathDeclarations() {
  const file = resolve("packages/desktop/src/main/desktopRuntimeEnv.ts");
  const source = await readFile(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "readRuntimeEnvOverride",
    "isTruthyRuntimeEnvOverride",
    "isLocalDevelopmentRuntime",
    "isPreviewPackagedRuntime",
    "runtimeApplicationName",
    "shouldUseElectronDefaultUserDataPath",
    "runtimeUserDataPath",
    "runtimeSessionDataPath",
  ]);
  // 旧测试绑定源码里的 ZCode 字面量，与独立目录 spec 冲突；执行真实初始化声明，
  // 只替换 Electron 边界，避免启动应用或触碰开发者的真实配置目录。
  const declarations = parsed.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text ?? "");
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text),
      )
    );
  });
  assert.equal(declarations.length, names.size, "runtime path declarations must remain available");
  return ts.transpileModule(declarations.map((statement) => statement.getText(parsed)).join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

test("desktop userData and sessionData use isolated UWork namespaces and respect overrides", async () => {
  const declarations = await loadDesktopPathDeclarations();
  for (const path of [posix, win32]) {
    const appData = path === win32 ? "C:\\fixture\\AppData" : "/fixture/app-data";
    const customData = path.join(appData, "fixture-profile");
    const customSession = path.join(appData, "fixture-session");
    const cases = [
      { packaged: true, flavor: "production", name: "UWork", env: {}, data: "UWork" },
      { packaged: false, flavor: "production", name: "UWork Dev", env: {}, data: "UWork Dev" },
      { packaged: true, flavor: "preview", name: "UWork Preview", env: {}, data: "UWork Preview" },
      { packaged: false, flavor: "preview", name: "UWork Dev", env: {}, data: "UWork Dev" },
      {
        packaged: true,
        flavor: "production",
        name: "Fixture App",
        data: "Fixture App",
        env: { ZCODE_DESKTOP_APPLICATION_NAME: " Fixture App " },
      },
      {
        packaged: true,
        flavor: "production",
        name: "UWork",
        data: customData,
        env: { ZCODE_DESKTOP_USER_DATA_DIR: customData },
      },
      {
        packaged: true,
        flavor: "production",
        name: "UWork",
        data: "UWork",
        session: customSession,
        env: { ZCODE_DESKTOP_SESSION_DATA_DIR: customSession },
      },
      {
        packaged: true,
        flavor: "production",
        name: "UWork",
        data: undefined,
        env: { ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1" },
      },
      {
        packaged: true,
        flavor: "production",
        name: "UWork",
        data: customData,
        env: {
          ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "true",
          ZCODE_DESKTOP_USER_DATA_DIR: customData,
        },
      },
      {
        packaged: true,
        flavor: "production",
        name: "UWork",
        data: "UWork",
        env: {
          ZCODE_DESKTOP_APPLICATION_NAME: " ",
          ZCODE_DESKTOP_USER_DATA_DIR: " ",
          ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "0",
        },
      },
    ];
    for (const scenario of cases) {
      const exports: Record<string, unknown> = {};
      runInNewContext(declarations, {
        exports,
        process: { env: scenario.env },
        join: path.join,
        ZCODE_PRODUCT_FLAVOR: scenario.flavor,
        isElectronAppPackaged: () => scenario.packaged,
        getElectronAppPath: (name: string) => {
          assert.equal(name, "appData");
          return appData;
        },
      });
      const expectedData =
        scenario.data === undefined ? undefined : path.resolve(appData, scenario.data);
      assert.equal(exports.runtimeApplicationName, scenario.name);
      assert.equal(exports.runtimeUserDataPath, expectedData);
      assert.equal(
        exports.runtimeSessionDataPath,
        scenario.session ?? (expectedData ? path.join(expectedData, "session") : undefined),
      );
    }
  }
});

test("service paths select the UWork data root with preferred and legacy environment overrides", async () => {
  const execFileAsync = promisify(execFile);
  const home = resolve("fixture-home");
  const preferred = resolve("fixture-uwork-base");
  const legacy = resolve("fixture-legacy-base");
  const cases = [
    { preferred: "", legacy: "", expected: home },
    { preferred: ` ${preferred} `, legacy, expected: preferred },
    { preferred: "", legacy, expected: legacy },
    { preferred: " ", legacy, expected: legacy },
  ];
  for (const scenario of cases) {
    // paths 在模块初始化时读取环境；子进程隔离避免模块缓存及并发测试污染。
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { getDataBaseDir, getZCodeDataRootDir, getAppConfigDir } from '@zcode/services/node';
      process.stdout.write(JSON.stringify([getDataBaseDir(), getZCodeDataRootDir(), getAppConfigDir()]));
    `,
      ],
      {
        cwd: resolve("packages/desktop"),
        env: {
          ...process.env,
          HOME: home,
          UWORK_DATA_BASE_DIR: scenario.preferred,
          ZCODE_DATA_BASE_DIR: scenario.legacy,
        },
      },
    );
    const root = join(scenario.expected, ".uwork");
    assert.deepEqual(JSON.parse(stdout), [scenario.expected, root, join(root, "v2")]);
  }
});
