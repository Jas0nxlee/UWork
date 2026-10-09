import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { relocateCliPathOverrides } from "./dataDirectoryMigrationMetadata.js";
import { UWORK_DATA_ROOT_DIR_NAME } from "@zcode/shared";

/** UWork 自有状态整体迁移；旧根保留，任何冲突/复制失败都不能静默切换到残缺状态。 */
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  const source = resolve(oldBaseDir, UWORK_DATA_ROOT_DIR_NAME);
  const target = resolve(newBaseDir, UWORK_DATA_ROOT_DIR_NAME);
  if (source === target) return;
  const contains = (parent: string, child: string) => {
    const part = relative(parent, child);
    return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
  };
  if (contains(source, target) || contains(target, source))
    throw new Error("UWork data directories must not overlap");
  const entries = await readdir(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length)
    throw new Error("UWork target data directory is not empty; choose an empty directory");
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), ".uwork-migration-"));
  const stagedRoot = join(stage, UWORK_DATA_ROOT_DIR_NAME);
  const include = async (path: string) => {
    const local = relative(source, path).split(sep).join("/");
    if (local === "v2/setting.json" || local.startsWith("v2/setting.json.")) return false;
    return !(await lstat(path)).isSymbolicLink();
  };
  try {
    await cp(source, stagedRoot, { recursive: true, filter: include });
    const canonicalSource = await realpath(source);
    const canonicalTarget = join(await realpath(dirname(target)), basename(target));
    const relocate = (value: unknown): unknown => {
      if (typeof value === "string") {
        for (const [oldRoot, newRoot] of [
          [source, target],
          [canonicalSource, canonicalTarget],
        ]) {
          if (value === oldRoot || value.startsWith(`${oldRoot}${sep}`))
            return newRoot! + value.slice(oldRoot!.length);
        }
      }
      if (Array.isArray(value)) return value.map(relocate);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, relocate(entry)]),
        );
      return value;
    };
    const verify = async (path: string) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const destination = join(path, entry.name);
        if (entry.isDirectory()) {
          await verify(destination);
          continue;
        }
        const original = join(source, relative(stagedRoot, destination));
        const bytes = await readFile(destination);
        const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
        if (digest(bytes) !== digest(await readFile(original)))
          throw new Error("UWork migration content verification failed");
        if (entry.name.endsWith(".json")) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bytes.toString("utf8"));
          } catch {
            continue;
          }
          const migrated = relocate(parsed);
          // skills/command 开关按绝对文件路径作键；仅这两个契约字段允许迁移键。
          if (
            relative(stagedRoot, destination).split(sep).join("/") === "cli/config.json" &&
            migrated &&
            typeof migrated === "object" &&
            !Array.isArray(migrated)
          ) {
            relocateCliPathOverrides(migrated as Record<string, unknown>, {
              source,
              target,
              canonicalSource,
              canonicalTarget,
            });
          }
          const updated = JSON.stringify(migrated, null, 2) + "\n";
          if (JSON.stringify(parsed) !== JSON.stringify(migrated))
            await writeFile(destination, updated, "utf8");
        }
      }
    };
    await verify(stagedRoot);
    // rename 前再次检查，避免覆盖迁移期间新增的目标文件。
    await rmdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(stagedRoot, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
