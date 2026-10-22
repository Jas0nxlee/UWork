import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractArchiveSafely } from "../src/runtime/componentCache.js";

// 组件级缓存/合并用例随在线自升级路径一起删除；这里只保留解包安全边界。
describe("safe archive extraction", () => {
  // Bugfix: Windows 普通用户无 symlink 权限，junction 会被 bsdtar 归档成普通目录
  // （不产生 POSIX symlink 条目），无法在归档内构造出待拒绝的符号链接场景，仅 POSIX 宿主运行。
  it.skipIf(process.platform === "win32")(
    "rejects symbolic links in release archives before extraction",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-component-link-"));
      const componentRoot = join(root, "component");
      await mkdir(componentRoot, { recursive: true });
      const outsideTarget = join(root, "outside-target");
      await mkdir(outsideTarget);
      await symlink(
        outsideTarget,
        join(componentRoot, "runtime"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const archive = join(root, "component.tar.gz");
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve, reject) =>
        execFile("tar", ["-czf", archive, "."], { cwd: componentRoot }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      const destination = join(root, "release");
      await mkdir(destination, { recursive: true });

      await expect(extractArchiveSafely(archive, destination)).rejects.toThrow(
        /symbolic|hard link/i,
      );
    },
  );
});
