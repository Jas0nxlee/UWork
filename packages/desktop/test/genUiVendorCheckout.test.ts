import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const assets = "apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets";
const tweak = "packages/desktop/src/renderer/src/plugin-sandbox/genUiTweakRuntime.js";

it("preserves pinned Gen UI hashes through Windows-style Git checkout", async () => {
  const root = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "gen-ui-checkout-"));
  const repository = join(directory, "repository");
  const output = join(directory, "checkout");
  const files = new Map<string, string>();
  const vendor = JSON.parse(await readFile(join(root, assets, "vendor/manifest.json"), "utf8")) as {
    resources: { file: string; sha256: string; licenseFile: string; licenseSha256: string }[];
  };
  for (const resource of vendor.resources) {
    files.set(`${assets}/vendor/${resource.file}`, resource.sha256);
    files.set(`${assets}/vendor/${resource.licenseFile}`, resource.licenseSha256);
  }
  const runtime = JSON.parse(
    await readFile(join(root, assets, "runtime-manifest.json"), "utf8"),
  ) as {
    files: Record<string, { sha256: string }>;
  };
  for (const [file, entry] of Object.entries(runtime.files)) {
    files.set(file === "tweak.js" ? tweak : `${assets}/${file}`, entry.sha256);
  }
  try {
    await mkdir(repository);
    for (const file of [".gitattributes", ...files.keys()]) {
      await mkdir(dirname(join(repository, file)), { recursive: true });
      await copyFile(join(root, file), join(repository, file));
    }
    await run("git", ["init", "--quiet"], { cwd: repository });
    await run(
      "git",
      ["-c", "core.autocrlf=false", "add", "--", ".gitattributes", ...files.keys()],
      {
        cwd: repository,
      },
    );
    // Windows 会按 autocrlf 改写普通文本；固定快照必须保持清单要求的原始字节。
    await run(
      "git",
      [
        "-c",
        "core.autocrlf=true",
        "-c",
        "core.eol=crlf",
        "checkout-index",
        "--all",
        `--prefix=${output}${sep}`,
      ],
      {
        cwd: repository,
      },
    );
    for (const [file, expected] of files) {
      const bytes = await readFile(join(output, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
