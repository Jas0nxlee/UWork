// 使用真实 coordinator、tasks Worker 和 CLI Worker 验证 fallback 在初始化前可用。
import assert from "node:assert/strict";
import { build } from "esbuild";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repo = resolve(import.meta.dirname, "../../..");
const root = await mkdtemp(join(tmpdir(), "uwork-coordinator-test-"));
try {
  const runtime = join(root, "runtime");
  await cp(join(repo, "packages/desktop/out/host"), runtime, { recursive: true });
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  const fixture = join(root, "fixture.ts");
  await writeFile(
    fixture,
    `
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHostDatabaseStartup } from ${JSON.stringify(join(repo, "packages/desktop/src/host/hostDatabaseStartup.ts"))};
import { createOpenWorkspaceStartupBootstrap, resolveStartupWindowBootstrap } from ${JSON.stringify(join(repo, "packages/desktop/src/main/startupWorkspace.ts"))};
const root = process.env.UWORK_STARTUP_FIXTURE_ROOT!;
const scenario = process.argv[2];
const fallback = join(root, 'managed', 'conversation');
const active = join(root, 'active');
const deleted = join(root, '已删除项目');
let targets: string[] | undefined;
if (scenario === 'deleted' || scenario === 'explicit') {
  await mkdir(active, { recursive: true });
  if (scenario === 'deleted') {
    const settings = join(root, 'settings.json');
    await writeFile(settings, JSON.stringify({lastWorkspaceSession:[{kind:'local',workspacePath:active}], recentProjects:[deleted]}));
    const bootstrap = await resolveStartupWindowBootstrap({settingsFile:settings,conversationWorkspaceDir:fallback});
    targets = bootstrap.agentWarmupTargets?.map(target => target.workspacePath);
  } else targets = createOpenWorkspaceStartupBootstrap(active).agentWarmupTargets?.map(target => target.workspacePath);
}
if (scenario === 'mkdir-failure') {
  await mkdir(join(root, 'managed'), {recursive:true});
  await writeFile(fallback, 'fixture blocks directory');
}
let initialized = false;
let directoryExistedBeforeWorker = false;
const phases: string[] = [];
const startup = createHostDatabaseStartup({
  cwd: fallback,
  workingDirectories: targets,
  publish(state) {
    phases.push(state.phase);
    if (state.phase === 'preparing_host_storage') directoryExistedBeforeWorker = statSync(fallback).isDirectory();
  },
  initializeServices: async () => { initialized = true; },
  onFailure: () => {},
});
await startup.coordinator.start();
if (scenario === 'mkdir-failure') {
  assert.equal(startup.coordinator.snapshot.phase, 'failed');
  assert.equal(initialized, false);
  assert.equal(phases.includes('preparing_host_storage'), false);
} else {
  assert.equal(startup.coordinator.snapshot.phase, 'ready');
  assert.equal(initialized, true);
  assert.equal(directoryExistedBeforeWorker, true);
  assert.equal(existsSync(deleted), false);
}
startup.dispose();
console.log('PASS coordinator: '+scenario);
`,
  );
  const bundle = join(runtime, "coordinator-fixture.mjs");
  await build({
    entryPoints: [fixture],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  for (const scenario of ["deleted", "explicit", "fresh", "mkdir-failure"]) {
    const data = join(root, scenario);
    await mkdir(data);
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [bundle, scenario], {
        cwd: repo,
        env: { ...process.env, UWORK_STARTUP_FIXTURE_ROOT: data, ZCODE_DATA_BASE_DIR: data },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (part) => {
        output += part.toString();
      });
      child.stderr.on("data", (part) => {
        output += part.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => done({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    console.log(`PASS coordinator: ${scenario}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
