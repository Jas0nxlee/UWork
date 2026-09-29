import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await readFile(resolve(root, "mise.toml"), "utf8");
const nodeVersion = config.match(/^node\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
const pnpmVersion = config.match(/^pnpm\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (!nodeVersion || !pnpmVersion || manifest.packageManager !== `pnpm@${pnpmVersion}`)
  throw new Error("mise.toml and packageManager must declare matching pinned toolchain versions");
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `node-version=${nodeVersion}\npnpm-version=${pnpmVersion}\n`,
  );
else console.log(JSON.stringify({ nodeVersion, pnpmVersion }));
