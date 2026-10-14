import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  archiveName,
  digest,
  readCrateArchive,
  requireValue,
} from "./windows-ripgrep-license-archive.mjs";
const noticeName =
  /(?:^|\/)(?:LICEN[CS]E(?:[._-][^/]*)?|COPYING(?:[._-][^/]*)?|COPYRIGHT(?:[._-][^/]*)?|NOTICE(?:[._-][^/]*)?|AUTHORS(?:[._-][^/]*)?)(?:$|\/)/iu;
const safeName = (name) => /^[a-zA-Z0-9_.-]+$/u.test(name);

export function isInside(root, path) {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

export async function checkedPath(root, path) {
  const actual = await realpath(path);
  requireValue(
    isInside(await realpath(root), actual),
    "Material path escapes its declared source root",
  );
  return actual;
}

export async function regularFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "target", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
  }
  return files;
}

function normalizeSource(value) {
  return value?.replace(/\/$/u, "");
}

export async function originalPackageNotices(pkg, lock, options, rustNotices, save) {
  requireValue(safeName(pkg.name) && safeName(pkg.version), "Invalid Cargo package identity");
  const directory = dirname(
    await checkedPath(
      pkg.source ? options.cargoHome : options.allowedWorkspaceRoot,
      pkg.manifest_path,
    ),
  );
  const declared = pkg.license_file
    ? pkg.source
      ? archiveName(pkg.license_file)
      : pkg.license_file
    : undefined;
  const folder = `cargo/${pkg.name}-${pkg.version}-${digest(pkg.id).slice(0, 10)}`;
  let notices;
  let archiveSha256;
  if (pkg.source) {
    requireValue(
      /^registry\+https:\/\/(?:github\.com\/rust-lang\/crates\.io-index|index\.crates\.io\/?)/u.test(
        pkg.source,
      ),
      `Unsupported public Cargo source for ${pkg.name}`,
    );
    const locked = lock.find(
      (item) =>
        item.name === pkg.name &&
        item.version === pkg.version &&
        normalizeSource(item.source) === normalizeSource(pkg.source),
    );
    requireValue(
      /^[0-9a-f]{64}$/u.test(locked?.checksum ?? ""),
      `Missing locked checksum for ${pkg.name}`,
    );
    const index = relative(join(options.cargoHome, "registry/src"), directory).split(sep)[0];
    requireValue(index && index !== "..", "Cargo registry source outside its declared home");
    const archive = join(
      options.cargoHome,
      "registry/cache",
      index,
      `${pkg.name}-${pkg.version}.crate`,
    );
    const bytes = await readFile(await checkedPath(options.cargoHome, archive));
    archiveSha256 = digest(bytes);
    const members = await readCrateArchive(bytes, locked.checksum);
    const prefix = `${pkg.name}-${pkg.version}/`;
    requireValue(
      [...members.keys()].every((name) => name.startsWith(prefix)),
      "Crate members disagree with package identity",
    );
    notices = [...members].flatMap(([member, content]) => {
      const name = member.slice(prefix.length);
      return noticeName.test(name) || name === declared ? [{ name, content }] : [];
    });
    if (declared)
      requireValue(
        members.has(prefix + declared),
        `Missing declared original license for ${pkg.name}`,
      );
  } else {
    const names = await regularFiles(directory);
    const selected = names.filter((name) => noticeName.test(name) || name === declared);
    notices = await Promise.all(
      selected.map(async (name) => ({
        name,
        content: await readFile(
          await checkedPath(options.allowedWorkspaceRoot, resolve(directory, name)),
        ),
      })),
    );
    if (declared && !selected.includes(declared)) {
      const path = await checkedPath(options.allowedWorkspaceRoot, resolve(directory, declared));
      notices.push({
        name: `declared-license/${path.split(sep).at(-1)}`,
        content: await readFile(path),
      });
    }
    if (
      !options.rustWorkspace &&
      notices.length === 0 &&
      pkg.license === options.workspaceLicense
    ) {
      // 同仓 workspace crate 共用原仓根授权；不是按 SPDX 拼接或借另一版本的版权。
      const rootNames = (await readdir(options.allowedWorkspaceRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && noticeName.test(entry.name))
        .map((entry) => entry.name);
      notices = await Promise.all(
        rootNames.map(async (name) => ({
          name: `repository-root/${name}`,
          content: await readFile(
            await checkedPath(
              options.allowedWorkspaceRoot,
              join(options.allowedWorkspaceRoot, name),
            ),
          ),
        })),
      );
    }
  }
  // rust-src in-tree 包的逐文件版权由同一 compiler revision 的官方生成材料覆盖。
  if (options.rustWorkspace && notices.length === 0)
    return {
      archiveSha256,
      notices: rustNotices,
      scope: "Rust in-tree source: original matching COPYRIGHT-library and all license texts",
    };
  requireValue(
    notices.length > 0,
    `No publisher original notice files for ${pkg.name}@${pkg.version}`,
  );
  return {
    archiveSha256,
    notices: await Promise.all(
      notices.map((notice) => save(`${folder}/${notice.name}`, notice.content)),
    ),
  };
}
