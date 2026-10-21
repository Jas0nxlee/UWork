import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolvePluginMcpServers } from "../src/plugins/mcp.js";
import { validateLocalPluginPath } from "../src/plugins/marketplace.js";
import type { LoadedPlugin } from "../src/plugins/types.js";

// office-editor 是仓库内的“插件形态”示例（plugins/office-editor，specs/office-editor-plugin.md）：
// 本测试走**宿主真实的加载链路**（清单校验 → MCP server 解析 → 命名空间）与**官方 MCP SDK 客户端**，
// 验证它不依赖任何核心改动就能被加载、连接与调用。python3 不可用时只跑静态校验。
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "../../../../../plugins/office-editor");
const pythonAvailable = spawnSync("python3", ["--version"]).status === 0;
const fixtureAvailable = existsSync(join(pluginRoot, "verify", "sample_fixture.py"));
const tempRoot = mkdtempSync(join(tmpdir(), "office-editor-load-"));

process.on("exit", () => rmSync(tempRoot, { recursive: true, force: true }));

function asLoadedPlugin(): LoadedPlugin {
  const manifestPath = join(pluginRoot, ".uwork-plugin", "plugin.json");
  return {
    id: "office-editor@local",
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as LoadedPlugin["manifest"],
    manifestPath,
    marketplace: "local",
    rootPath: pluginRoot,
    source: { source: "directory", path: pluginRoot },
  } as LoadedPlugin;
}

function resolveOfficeServer(): { command: string; args: string[]; env: Record<string, string> } {
  const diagnostics: Parameters<typeof resolvePluginMcpServers>[0]["diagnostics"] = [];
  const servers = resolvePluginMcpServers({
    dataPath: tempRoot,
    diagnostics,
    env: process.env,
    loaded: asLoadedPlugin(),
    options: {},
    workingDirectory: pluginRoot,
  });
  assert.deepEqual(
    diagnostics.filter((item) => item.severity === "error"),
    [],
  );
  return servers["plugin:office-editor:office"] as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

function sampleDocument(): string {
  const directory = mkdtempSync(join(tempRoot, "sample-"));
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import sample_fixture; print(sample_fixture.build_sample(sys.argv[2]))",
      join(pluginRoot, "verify"),
      directory,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test(
  "office-editor rejects unsafe document packages and stale writes",
  { skip: !pythonAvailable ? "python3 unavailable" : false },
  () => {
    const result = spawnSync(
      "python3",
      [
        "-m",
        "unittest",
        "discover",
        "-s",
        join(pluginRoot, "verify"),
        "-p",
        "test_document_safety.py",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);

test("office-editor page keeps async exports bound to their document", () => {
  const result = spawnSync(
    process.execPath,
    ["--test", join(pluginRoot, "verify", "page_safety.test.mjs")],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("office-editor passes the local plugin validator without errors", async () => {
  const diagnostics = await validateLocalPluginPath({ path: pluginRoot, storageRoot: tempRoot });
  const errors = diagnostics.filter((item) => item.severity === "error");
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
});

test("office-editor resolves its stdio MCP server with the plugin root injected", () => {
  const office = resolveOfficeServer();
  assert.equal(office.command, "python3");
  assert.equal(office.args[0], join(pluginRoot, "server", "server.py"));
  // UWork 命名是首选；ZCODE_* / CLAUDE_* 仍同时注入，保证既有插件不受影响。
  assert.equal(office.env.UWORK_PLUGIN_ROOT, pluginRoot);
  assert.equal(office.env.UWORK_PLUGIN_ID, "office-editor@local");
  assert.equal(office.env.ZCODE_PLUGIN_ROOT, pluginRoot);
  assert.equal(office.env.ZCODE_PLUGIN_ID, "office-editor@local");
});

test(
  "official MCP client drives office-editor tools and its page resource",
  { skip: !pythonAvailable || !fixtureAvailable ? "python3 or fixture unavailable" : false },
  async () => {
    const office = resolveOfficeServer();
    const client = new Client(
      { name: "office-editor-verify", version: "0.0.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: office.command,
      args: office.args,
      cwd: pluginRoot,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...office.env }).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "docx_comments_list",
        "docx_current_target",
        "docx_edit_paragraph",
        "docx_export_pdf",
        "docx_open_editor",
        "docx_revisions_list",
        "docx_revisions_resolve",
        "docx_set_paragraph_format",
        "docx_write_back",
      ]);
      // 页面描述必须挂在 tools/list 的工具描述上（宿主只读这里；放在调用结果上不会被识别）。
      const openTool = tools.tools.find((tool) => tool.name === "docx_open_editor") as
        | { _meta?: { ui?: { resourceUri?: string } } }
        | undefined;
      assert.equal(
        openTool?._meta?.ui?.resourceUri,
        "ui://office-editor/editor.html",
        JSON.stringify(openTool?._meta),
      );

      const sample = sampleDocument();
      const listed = await client.callTool({
        name: "docx_revisions_list",
        arguments: { path: sample },
      });
      const payload = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
      assert.deepEqual(payload.counts, { insert: 1, delete: 1, comments: 0 });

      const opened = await client.callTool({
        name: "docx_open_editor",
        arguments: { path: sample },
      });
      // MCP 工具结果的页面引用放在 `_meta`（标准键 `ui.resourceUri` 的嵌套形式）。
      const openedMeta = (opened as { _meta?: { ui?: { resourceUri?: string } } })._meta;
      assert.equal(openedMeta?.ui?.resourceUri, "ui://office-editor/editor.html");

      const page = await client.readResource({ uri: "ui://office-editor/editor.html" });
      const html = (page.contents[0] as { text: string }).text;
      const pageMeta = (page.contents[0] as { _meta?: Record<string, unknown> })._meta;
      assert.deepEqual(pageMeta?.["zcode/csp"], { unsafeEval: true });
      assert.match(html, /Word 修订审阅/);
      assert.ok(html.length > 1000, `page too small: ${html.length}`);
    } finally {
      await client.close();
    }
  },
);
