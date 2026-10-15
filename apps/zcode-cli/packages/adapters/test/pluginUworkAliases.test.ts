import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePluginMcpServers } from "../src/plugins/mcp.js";
import { validateLocalPluginPath } from "../src/plugins/marketplace.js";
import type { LoadedPlugin } from "../src/plugins/types.js";

// UWork 命名的插件契约面：`.uwork-plugin/plugin.json` + `UWORK_PLUGIN_ROOT` 等占位符/env，
// 同时保留 `.zcode-plugin`（及 Claude/Codex 约定）的读取兼容，让上游生态的既有插件继续可用。
const tempRoot = mkdtempSync(join(tmpdir(), "plugin-uwork-alias-"));
process.on("exit", () => rmSync(tempRoot, { recursive: true, force: true }));

function writeManifest(root: string, dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function demoPlugin(name: string, dir: string, placeholder = "UWORK_PLUGIN_ROOT"): string {
  const root = join(tempRoot, name);
  writeManifest(root, dir, {
    name,
    version: "0.1.0",
    license: "Apache-2.0",
    mcpServers: {
      demo: { type: "stdio", command: "python3", args: [`\${${placeholder}}/server/demo.py`] },
    },
  });
  return root;
}

function asLoaded(root: string, id: string): LoadedPlugin {
  // 从磁盘读真实清单（含 mcpServers），与宿主加载后的 LoadedPlugin 同源。
  const manifestPath = [".uwork-plugin", ".zcode-plugin"]
    .map((dir) => join(root, dir, "plugin.json"))
    .find((candidate) => existsSync(candidate));
  assert.ok(manifestPath, `missing manifest under ${root}`);
  return {
    id,
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as LoadedPlugin["manifest"],
    manifestPath,
    marketplace: "local",
    rootPath: root,
    source: { source: "directory", path: root },
  } as LoadedPlugin;
}

test("discovers a plugin that only ships .uwork-plugin/plugin.json", async () => {
  const root = demoPlugin("uwork-only", ".uwork-plugin");
  const diagnostics = await validateLocalPluginPath({ path: root, storageRoot: tempRoot });
  assert.deepEqual(
    diagnostics.filter((item) => item.severity === "error"),
    [],
  );
});

test("still loads a legacy .zcode-plugin plugin", async () => {
  const root = demoPlugin("legacy-only", ".zcode-plugin", "ZCODE_PLUGIN_ROOT");
  const diagnostics = await validateLocalPluginPath({ path: root, storageRoot: tempRoot });
  assert.deepEqual(
    diagnostics.filter((item) => item.severity === "error"),
    [],
  );
});

test("prefers .uwork-plugin when both manifest directories exist", async () => {
  const root = join(tempRoot, "both");
  writeManifest(root, ".uwork-plugin", { name: "both", version: "0.2.0", license: "Apache-2.0" });
  // 旧目录里放一个非法名字：若发现阶段优先读到它，校验就会报错。
  writeManifest(root, ".zcode-plugin", { name: "INVALID NAME", version: "0.1.0" });
  const diagnostics = await validateLocalPluginPath({ path: root, storageRoot: tempRoot });
  assert.deepEqual(
    diagnostics.filter((item) => item.severity === "error"),
    [],
  );
});

test("expands ${UWORK_PLUGIN_ROOT} and injects both UWork and legacy env keys", () => {
  const root = demoPlugin("uwork-only", ".uwork-plugin");
  const diagnostics: Parameters<typeof resolvePluginMcpServers>[0]["diagnostics"] = [];
  const servers = resolvePluginMcpServers({
    dataPath: join(tempRoot, "data"),
    diagnostics,
    env: process.env,
    loaded: asLoaded(root, "uwork-only@local"),
    options: {},
    workingDirectory: tempRoot,
  });
  assert.deepEqual(
    diagnostics.filter((item) => item.severity === "error"),
    [],
  );
  const demo = servers["plugin:uwork-only:demo"] as {
    args?: string[];
    env?: Record<string, string>;
  };
  assert.equal(demo.args?.[0], join(root, "server", "demo.py"));
  assert.equal(demo.env?.UWORK_PLUGIN_ROOT, root);
  assert.equal(demo.env?.UWORK_PLUGIN_ID, "uwork-only@local");
  assert.equal(demo.env?.UWORK_PLUGIN_DATA, join(tempRoot, "data"));
  // 兼容面：既有插件的 ZCODE_* / CLAUDE_* 仍在。
  assert.equal(demo.env?.ZCODE_PLUGIN_ROOT, root);
  assert.equal(demo.env?.ZCODE_PLUGIN_ID, "uwork-only@local");
  assert.equal(demo.env?.CLAUDE_PLUGIN_ROOT, root);
});

test("expands the legacy ${ZCODE_PLUGIN_ROOT} placeholder too", () => {
  const root = demoPlugin("legacy-only", ".zcode-plugin", "ZCODE_PLUGIN_ROOT");
  const diagnostics: Parameters<typeof resolvePluginMcpServers>[0]["diagnostics"] = [];
  const servers = resolvePluginMcpServers({
    dataPath: join(tempRoot, "data"),
    diagnostics,
    env: process.env,
    loaded: asLoaded(root, "legacy-only@local"),
    options: {},
    workingDirectory: tempRoot,
  });
  const demo = servers["plugin:legacy-only:demo"] as { args?: string[] };
  assert.equal(demo.args?.[0], join(root, "server", "demo.py"));
  assert.ok(existsSync(join(root, ".zcode-plugin", "plugin.json")));
});
