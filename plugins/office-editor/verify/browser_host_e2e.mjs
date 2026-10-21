// Manual E2E: current production MCP Apps host + Agent + real office Python MCP.
// No external engine/model; only a generated DOCX under .tmp is read or changed.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const verify = dirname(fileURLToPath(import.meta.url));
const root = resolve(verify, "../../..");
const fixture = join(root, "packages/desktop/scripts/mcp-apps-host-fixture");
const output = join(
  root,
  ".tmp/office-editor-browser-e2e",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
const python = process.env.OFFICE_EDITOR_E2E_PYTHON || "python3";
const config = JSON.parse(await readFile(join(verify, "../engine.json"), "utf8"));
assert.equal(
  config.baseUrl,
  "",
  "This manual test covers the default read-only fallback; do not configure an engine to run it",
);
await mkdir(join(output, "assets"), { recursive: true });
const { stdout: sampleOutput } = await execFileAsync(
  python,
  [
    "-c",
    `import sys;sys.path.insert(0,${JSON.stringify(verify)});import sample_fixture;print(sample_fixture.build_sample(${JSON.stringify(output)}))`,
  ],
  { encoding: "utf8" },
);
const sample = sampleOutput.trim();
const sharedExports = JSON.parse(
  await readFile(join(root, "packages/shared/package.json"), "utf8"),
).exports;
const alias = {
  "@": join(root, "packages/ui/src"),
  ...Object.fromEntries(
    Object.entries(sharedExports).map(([key, value]) => [
      key === "." ? "@zcode/shared" : `@zcode/shared/${key.slice(2)}`,
      resolve(root, "packages/shared", value),
    ]),
  ),
  "@modelcontextprotocol/ext-apps": require.resolve("@modelcontextprotocol/ext-apps", {
    paths: [join(root, "packages/ui")],
  }),
  "@modelcontextprotocol/ext-apps/app-bridge": require.resolve(
    "@modelcontextprotocol/ext-apps/app-bridge",
    { paths: [join(root, "packages/ui")] },
  ),
};
const bundle = (entry, file, platform = "browser") =>
  build({
    entryPoints: [entry],
    outfile: join(output, file),
    bundle: true,
    platform,
    jsx: "automatic",
    format: platform === "node" ? "cjs" : "iife",
    external: ["electron"],
    loader: { ".png": "dataurl", ".svg": "dataurl" },
    alias,
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"PROD":true,"BASE_URL":"./"}',
    },
    logLevel: "warning",
    plugins: [
      {
        name: "fixture-assets",
        setup(builder) {
          builder.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.slice(0, -4)),
            namespace: "raw",
          }));
          builder.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({
            contents: await readFile(args.path, "utf8"),
            loader: "text",
          }));
          builder.onResolve({ filter: /\?url$/ }, (args) => ({
            path: require.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }),
            namespace: "url",
          }));
          builder.onLoad({ filter: /.*/, namespace: "url" }, async (args) => ({
            contents: await readFile(args.path),
            loader: "file",
          }));
        },
      },
    ],
  });
try {
  await Promise.all([
    bundle(join(verify, "browser_host_main.ts"), "main.cjs", "node"),
    bundle(join(fixture, "managed-renderer.tsx"), "managed.js"),
    bundle(join(fixture, "preload.ts"), "preload.cjs", "node"),
    bundle(join(root, "packages/desktop/src/preload/pluginSandbox/index.ts"), "guest.cjs", "node"),
    bundle(
      join(root, "packages/desktop/src/renderer/src/plugin-sandbox/main.ts"),
      "assets/shell.js",
    ),
    bundle(
      join(root, "packages/desktop/src/renderer/src/plugin-sandbox/alias.ts"),
      "plugin-sandbox-alias.js",
    ),
  ]);
  // Same HTML shell as the existing repository managed-host fixture; no replacement UI.
  await writeFile(
    join(output, "managed.html"),
    '<!doctype html><meta charset="utf-8"><style>.h-full{height:100%}.w-full{width:100%}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.overflow-y-auto{overflow-y:auto}.relative{position:relative}</style><body><div id="root"></div><script src="managed.js"></script>',
  );
  await writeFile(
    join(output, "plugin-sandbox.html"),
    '<!doctype html><style>html,body,#root,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style><div id="root"></div><script src="/assets/shell.js"></script>',
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((accept, reject) => {
    const child = spawn(
      require("electron"),
      [join(output, "main.cjs"), output, root, process.execPath, sample, python],
      { env, stdio: "inherit" },
    );
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Office MCP host test deadline"));
    }, 120_000);
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      if (code === 0) accept();
      else reject(new Error(`Office host result ${code}; artifacts: ${output}`));
    });
    child.on("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
  });
  const { stdout: diskOutput } = await execFileAsync(
    python,
    [
      "-c",
      `import sys,json,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 root=E.fromstring(z.read('word/document.xml')); ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 assert not root.findall('.//w:ins',ns) and not root.findall('.//w:del',ns)
 text=''.join(root.itertext()); assert '插入的新句子。' in text and '被删掉的旧句子。' in text
 assert z.read('word/styles.xml')==b'<styles/>'
 print(json.dumps({'zipValid':True,'remainingInsertions':0,'remainingDeletions':0,'insertedTextRetained':True,'rejectedDeletionTextRestored':True,'unrelatedStylesBytesPreserved':True}))`,
      sample,
    ],
    { encoding: "utf8" },
  );
  const disk = JSON.parse(diskOutput);
  const result = JSON.parse(await readFile(join(output, "results.json"), "utf8"));
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ ...result, diskVerification: disk }, null, 2),
  );
  console.log(`PASS Office MCP Apps manual E2E; screenshots and computed rectangles: ${output}`);
} finally {
  // Keep inspectable screenshots/results, but never leave the synthesized source or its backups.
  for (const name of await readdir(output))
    if (name === "sample.docx" || /^sample_backup(?:-\d+)?\.docx$/.test(name))
      await rm(join(output, name), { force: true });
}
