import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import test, { type TestContext } from "node:test";
import type { ZipExtractor } from "./contract.ts";
import { extractOwnedArchive } from "./contract.example.ts";

const require = createRequire(import.meta.url);
// 使用 package.json 的 main 入口，消费契约不得绕过公开边界读取 adapters 实现。
const extract: ZipExtractor = require("./");
const { ZipFile } = require("yazl");

async function archiveFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "uwork-zip-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, "input.zip");
  const directory = join(root, "output");
  await mkdir(directory);
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("consumer asset"), "nested/asset.txt");
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archive));
  return { root, archive, directory };
}

test("the documented consumer can await the public package entrypoint before reading extracted files", async (t) => {
  const { archive, directory } = await archiveFixture(t);
  const completion = extractOwnedArchive(extract, archive, directory);
  assert.ok(completion instanceof Promise);
  await completion;
  assert.equal(await readFile(join(directory, "nested/asset.txt"), "utf8"), "consumer asset");
});

test("async onEntry failures reject the public extraction promise", async (t) => {
  const { archive, directory } = await archiveFixture(t);
  const callbackError = new Error("consumer rejected the archive entry");
  let observedEntry: string | undefined;
  await assert.rejects(
    extract(archive, {
      dir: directory,
      onEntry: async (entry) => {
        await Promise.resolve();
        observedEntry = entry.fileName;
        throw callbackError;
      },
    }),
    callbackError,
  );
  assert.equal(observedEntry, "nested/asset.txt");
});

test("public consumers receive a rejected promise for relative output directories", async (t) => {
  const { archive } = await archiveFixture(t);
  await assert.rejects(extractOwnedArchive(extract, archive, "relative-output"), /absolute/);
});
