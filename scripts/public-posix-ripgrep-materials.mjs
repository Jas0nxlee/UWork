import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, fetchPinnedBytes } from "./public-windows-ripgrep-source.mjs";
import { sha256, assertSha256 } from "./public-windows-ripgrep-plan.mjs";
import {
  PUBLIC_POSIX_RIPGREP_PINS as pins,
  readPosixRustComponents,
} from "./public-posix-ripgrep-plan.mjs";
import { collectGraph } from "./collect-windows-ripgrep-license-materials.mjs";
import {
  originalPackageNotices,
  regularFiles,
  checkedPath,
} from "./windows-ripgrep-license-files.mjs";
import { parseCargoLock } from "./windows-ripgrep-license-archive.mjs";
import { assertCompilerComponentFile } from "./public-windows-ripgrep-build-evidence.mjs";

export async function installPosixRustComponents(work, artifacts, plan, manifest) {
  const prefix = join(work, "toolchain");
  const components = readPosixRustComponents(manifest, plan);
  await mkdir(join(artifacts, "rust-components"));
  for (const [index, component] of components.entries()) {
    const directory = join(work, `rust-component-${index}`);
    await mkdir(directory);
    component.file = `rust-components/${basename(new URL(component.url).pathname)}`;
    const archive = join(artifacts, component.file);
    await writeFile(
      archive,
      await fetchPinnedBytes(component.url, component.sha256, component.component),
    );
    await execute("tar", ["-xJf", archive, "-C", directory, "--strip-components=1"], {
      capture: true,
    });
    await execute(
      "sh",
      [join(directory, "install.sh"), `--prefix=${prefix}`, "--disable-ldconfig"],
      {
        capture: true,
        logPath: join(artifacts, `rust-install-${index}.log`),
      },
    );
  }
  const installedFiles = await bindInstalledPosixRustComponents(work, prefix, plan, components);
  return { prefix, components, installedFiles };
}

export async function bindInstalledPosixRustComponents(work, prefix, plan, components) {
  const installedFiles = [];
  for (const [index, component] of components.entries()) {
    const directory = join(work, `rust-component-${index}`);
    const payloads = (await readFile(join(directory, "components"), "utf8")).trim().split(/\r?\n/u);
    for (const payload of payloads) {
      if (!/^[a-zA-Z0-9._-]+$/u.test(payload))
        throw new Error("Invalid official component payload name");
      const root = join(directory, payload);
      for (const file of await regularFiles(root)) {
        if (!/^(?:bin|lib)\//u.test(file) || file.startsWith("lib/rustlib/src/")) continue;
        installedFiles.push({
          path: file,
          component: component.component,
          sha256: assertCompilerComponentFile(
            await readFile(join(root, file)),
            await readFile(join(prefix, file)),
            file,
          ),
        });
      }
    }
  }
  if (
    !installedFiles.some((file) => file.path === "bin/rustc") ||
    !installedFiles.some((file) => file.path === "bin/cargo") ||
    !installedFiles.some((file) => file.path.startsWith(`lib/rustlib/${plan.target}/lib/libstd-`))
  )
    throw new Error("Missing installed official compiler/cargo/target std closure");
  return installedFiles;
}

export async function collectPosixRipgrepMaterials({
  sourceDir,
  cargoHome,
  prefix,
  metadata,
  artifacts,
  plan,
  buildMessages,
}) {
  const root = join(artifacts, "materials");
  await mkdir(root);
  const save = async (file, content) => {
    const path = join(root, file);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
    return { file, sha256: sha256(content), bytes: content.length };
  };
  const documentation = join(prefix, "share/doc/rust");
  const names = await regularFiles(documentation);
  const selected = names.filter((name) =>
    /^(?:COPYRIGHT[^/]*\.html|LICENSE[^/]*|licenses\/)/u.test(name),
  );
  if (!selected.includes("COPYRIGHT-library.html") || !selected.includes("COPYRIGHT.html"))
    throw new Error(
      "Rust 1.88 distribution must include complete compiler and library copyright originals",
    );
  // 原始 HTML 的相对许可引用也必须完整归档，不能只留三份顶层授权。
  for (let i = 0; i < selected.length; i++) {
    if (!selected[i].endsWith(".html")) continue;
    const bytes = await readFile(
      await checkedPath(documentation, join(documentation, selected[i])),
    );
    for (const m of bytes.toString("utf8").matchAll(/href=["']([^"'#]+)["']/gu)) {
      if (/^(?:https?:|mailto:)/iu.test(m[1])) continue;
      const link = decodeURIComponent(m[1]);
      const full = await checkedPath(
        documentation,
        resolve(documentation, selected[i], "..", link),
      );
      const file = relative(await realpath(documentation), full)
        .split(sep)
        .join("/");
      if (!selected.includes(file)) selected.push(file);
    }
  }
  const rustDistribution = [];
  for (const file of selected.sort())
    rustDistribution.push(
      await save(`rust/distribution/${file}`, await readFile(join(documentation, file))),
    );
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const rustSource = [];
  for (const notice of pins.sourceNotices) {
    const bytes = await readFile(
      join(repoRoot, "third-party/native-search/licenses", `${notice.sha256}.txt`),
    );
    assertSha256(bytes, notice.sha256, `Rust source ${notice.path}`);
    rustSource.push({
      source: `https://raw.githubusercontent.com/rust-lang/rust/${pins.rustCommit}/${notice.path}`,
      ...(await save(`rust/source/${notice.path}`, bytes)),
    });
  }
  const graph = collectGraph(metadata, new Set(["ripgrep"]));
  const lock = parseCargoLock(await readFile(join(sourceDir, "Cargo.lock"), "utf8"));
  const packages = [];
  for (const pkg of graph.values())
    packages.push({
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      source: pkg.source ?? "prepared source",
      ...(await originalPackageNotices(
        pkg,
        lock,
        {
          cargoHome,
          allowedWorkspaceRoot: sourceDir,
          workspaceLicense: metadata.packages.find((pkg) => pkg.name === "ripgrep")?.license,
        },
        [],
        save,
      )),
    });
  for (const entry of buildMessages.filter((x) => x.reason === "compiler-artifact"))
    if (!graph.has(entry.package_id))
      throw new Error(`Compiler artifact outside Cargo license graph: ${entry.package_id}`);
  const patch = await readFile(join(artifacts, "microsoft-producer-LICENSE"));
  const patchLicense = await save("microsoft-producer-LICENSE", patch);
  const nativePackages = [];
  const nativeCommonLicenses = [];
  if (plan.platform === "linux") {
    const all = await execute(
      "dpkg-query",
      ["-W", "-f=${binary:Package}\t${Version}\t${db:Status-Status}\n"],
      { capture: true },
    );
    for (const line of all.trim().split("\n")) {
      const [name, version, status] = line.split("\t");
      if (
        status !== "installed" ||
        !/^(?:musl(?:-|:|$)|gcc(?:-\d+(?:-base)?|:|$)|libgcc-|binutils(?:-|:|$)|lld(?:-\d+|:|$))/u.test(
          name,
        )
      )
        continue;
      const copyright = await readFile(`/usr/share/doc/${name.split(":")[0]}/copyright`);
      nativePackages.push({
        name,
        version,
        ...(await save(`native/${name.replaceAll(":", "-")}-copyright`, copyright)),
      });
    }
    if (
      !nativePackages.some((p) => p.name === "musl") ||
      !nativePackages.some((p) => /^gcc(?:-|$)/u.test(p.name))
    )
      throw new Error("Missing actual musl/GCC original package copyright");
    for (const entry of await readdir("/usr/share/common-licenses", { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const file = entry.name;
      nativeCommonLicenses.push(
        await save(
          `native/common-licenses/${file}`,
          await readFile(
            await checkedPath(
              "/usr/share/common-licenses",
              join("/usr/share/common-licenses", file),
            ),
          ),
        ),
      );
    }
  }
  const result = {
    schemaVersion: 1,
    status: "candidate-materials-collected",
    toolchain: pins,
    target: plan.target,
    rustDistribution,
    rustSource,
    packages,
    patchLicense,
    nativePackages,
    nativeCommonLicenses,
    inputs: Object.fromEntries(
      await Promise.all(
        [
          "Cargo.lock",
          "cargo-metadata.json",
          "cargo-build-messages.jsonl",
          "rustc-vv.txt",
          "pcre2-source-evidence.json",
        ].map(async (file) => [file, sha256(await readFile(join(artifacts, file)))]),
      ),
    ),
    unprovedScope: [],
  };
  await writeFile(join(root, "materials.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
