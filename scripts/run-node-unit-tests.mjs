#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeUnitTestFiles } from "./node-unit-test-files.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

export function runNodeUnitTests(
  files = nodeUnitTestFiles,
  { cwd = repositoryRoot, stdio = "inherit" } = {},
) {
  return new Promise((resolveExit, reject) => {
    if (
      !Array.isArray(files) ||
      !files.length ||
      !files.every((file) => typeof file === "string" && file.trim())
    ) {
      return reject(new Error("Node 单测文件清单不能为空，且每项必须为非空路径"));
    }
    const env = { ...process.env };
    // Node worker 的私有上下文不能传给新的 test 主进程，否则子进程会零测试成功退出。
    delete env.NODE_TEST_CONTEXT;
    // 修复依据：node:test 不能由 Vitest 代跑；固定同一清单，使用当前 Node 与已安装的 TS loader。
    const child = spawn(process.execPath, ["--import", tsxLoader, "--test", ...files], {
      cwd,
      env,
      stdio,
      shell: false,
    });
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") console.log(nodeUnitTestFiles.join("\n"));
  else if (args.length) {
    console.error("用法：node scripts/run-node-unit-tests.mjs [--list]");
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await runNodeUnitTests();
    } catch (error) {
      console.error(`[node-unit] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  }
}
