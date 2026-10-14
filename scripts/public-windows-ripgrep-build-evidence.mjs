import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { PUBLIC_WINDOWS_RIPGREP_PINS as pins, sha256 } from "./public-windows-ripgrep-plan.mjs";
import { execute, fetchPinnedBytes } from "./public-windows-ripgrep-source.mjs";

const normalizedPath = (value) =>
  value.replaceAll("\\\\", "\\").replaceAll("\\", "/").toLowerCase();

export function assertCompilerComponentFile(official, installed, path) {
  assert.ok(official.equals(installed), `Installed ${path} differs from the official component`);
  return sha256(installed);
}

export async function bindOfficialRustCompilerComponent({
  component,
  sysroot,
  workDir,
  artifactsDir,
  env,
}) {
  const bytes = await fetchPinnedBytes(component.url, component.sha256, "official rustc component");
  const archiveFile = "official-rustc-component.tar.xz";
  await writeFile(join(artifactsDir, archiveFile), bytes);
  const extracted = join(workDir, "official-rustc-component");
  await mkdir(extracted);
  await execute("tar", ["-xf", join(artifactsDir, archiveFile), "-C", extracted], { env });
  const roots = await readdir(extracted);
  assert.equal(roots.length, 1, "Unexpected official rustc archive root");
  const compilerRoot = join(extracted, roots[0], "rustc");
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        assert.ok(entry.isFile(), "Unexpected compiler component file type");
        const local = relative(compilerRoot, path);
        const digest = assertCompilerComponentFile(
          await readFile(path),
          await readFile(join(sysroot, local)),
          local,
        );
        files.push({ path: local.split(sep).join("/"), sha256: digest });
      }
    }
  }
  // rustc.exe 加载 rustc_driver DLL；核对 bin/lib 整个编译器闭包，不能只核对启动器。
  for (const directory of ["bin", "lib"]) await visit(join(compilerRoot, directory));
  assert.ok(
    files.some((entry) => entry.path === "bin/rustc.exe"),
    "Missing official rustc.exe",
  );
  assert.ok(
    files.some((entry) => /rustc_driver.*\.dll$/u.test(entry.path)),
    "Missing official rustc driver",
  );
  return {
    archive: { file: archiveFile, sha256: component.sha256, url: component.url },
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function readBuildProvenance(log) {
  const lines = log.split(/\r?\n/u);
  const messages = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  const artifact = (name) => {
    const matches = messages.filter(
      (message) => message.reason === "compiler-artifact" && message.target?.name === name,
    );
    assert.equal(matches.length, 1, `Expected one ${name} compiler artifact`);
    assert.equal(matches[0].fresh, false, `${name} must be freshly compiled`);
    return matches[0];
  };
  const stdArtifact = artifact("std");
  const panicArtifact = artifact("panic_unwind");
  const rgArtifact = artifact("rg");
  const compilerCommand = (name) => {
    const command = lines.find(
      (line) => line.includes(`--crate-name ${name} `) && /rustc(?:\.exe)? /u.test(line),
    );
    assert.ok(command, `Missing actual ${name} compiler command`);
    assert.match(command, /-C\s*control-flow-guard=yes/u, `Missing ${name} CFG enforcement`);
    assert.match(command, /-Z\s*stack-protector=all/u, `Missing ${name} stack protection`);
    assert.ok(
      command.includes(`/rustc/${pins.rustCommit}`),
      `Missing ${name} pinned rust-src binding`,
    );
    return command;
  };
  const stdCompilerCommand = compilerCommand("std");
  const rgCompilerCommand = compilerCommand("rg");
  const linkedArtifacts = [stdArtifact, panicArtifact].map((entry) => {
    const rlib = entry.filenames?.find((file) =>
      new RegExp(`[/\\\\]lib${entry.target.name}-[a-f0-9]+\\.rlib$`, "u").test(file),
    );
    assert.ok(rlib, `Missing fresh ${entry.target.name} rlib`);
    return rlib;
  });
  const linkCommand = lines.find((line) => {
    const normalized = normalizedPath(line);
    return (
      /(?:link|rust-lld)\.exe[" ]/u.test(normalized) &&
      /\/out:[^"\r\n]*\/rg(?:-[a-f0-9]+)?\.exe/u.test(normalized)
    );
  });
  assert.ok(linkCommand, "Missing actual final rg linker command");
  for (const path of linkedArtifacts)
    assert.ok(
      normalizedPath(linkCommand).includes(normalizedPath(path)),
      `Final link does not use freshly rebuilt ${path}`,
    );
  if (
    /D9002|ignoring unknown option|argument unused.*(?:control-flow-guard|stack-protector)/iu.test(
      log,
    )
  )
    throw new Error("A required hardening flag was ignored by the compiler");
  return {
    stdArtifact,
    panicArtifact,
    rgArtifact,
    stdCompilerCommand,
    rgCompilerCommand,
    linkCommand,
    linkedArtifacts,
  };
}

function reader(bytes, label) {
  const slice = (offset, size) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > bytes.length
    )
      throw new Error(`Truncated ${label}`);
    return bytes.subarray(offset, offset + size);
  };
  return {
    slice,
    u16: (offset) => slice(offset, 2).readUInt16LE(0),
    u32: (offset) => slice(offset, 4).readUInt32LE(0),
  };
}

// MSF/PDB 格式依据 LLVM 文档；用真实 info stream GUID/age 绑定 PE，不能用文件名替代。
// https://llvm.org/docs/PDB/MsfFile.html https://llvm.org/docs/PDB/PdbStream.html
function readPdbIdentity(bytes) {
  const r = reader(bytes, "PDB");
  assert.equal(
    r.slice(0, 32).toString("binary"),
    "Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0",
    "Unsupported PDB MSF format",
  );
  const blockSize = r.u32(32);
  assert.ok([512, 1024, 2048, 4096].includes(blockSize), "Unsupported PDB block size");
  const blockCount = r.u32(40);
  assert.equal(blockCount * blockSize, bytes.length, "Truncated PDB blocks");
  const block = (number) => {
    assert.ok(number < blockCount, "PDB block outside file");
    return r.slice(number * blockSize, blockSize);
  };
  const directorySize = r.u32(44);
  const directoryBlocks = Math.ceil(directorySize / blockSize);
  assert.ok(directoryBlocks <= blockSize / 4, "Unsupported PDB directory map size");
  const blockMap = reader(block(r.u32(52)), "PDB block map");
  const directory = reader(
    Buffer.concat(
      Array.from({ length: directoryBlocks }, (_, i) => block(blockMap.u32(i * 4))),
    ).subarray(0, directorySize),
    "PDB directory",
  );
  const streamCount = directory.u32(0);
  assert.ok(streamCount >= 2 && streamCount <= (directorySize - 4) / 4, "Missing PDB info stream");
  let position = 4 + streamCount * 4;
  for (let stream = 0; stream <= 1; stream++) {
    const size = directory.u32(4 + stream * 4);
    assert.notEqual(size, 0xffffffff, "Missing PDB info stream");
    const blocks = Math.ceil(size / blockSize);
    const contents = Buffer.concat(
      Array.from({ length: blocks }, (_, i) => block(directory.u32(position + i * 4))),
    ).subarray(0, size);
    position += blocks * 4;
    if (stream === 1) {
      const info = reader(contents, "PDB info stream");
      return { guid: info.slice(12, 16).toString("hex"), age: info.u32(8) };
    }
  }
}

function readPePdbIdentity(bytes) {
  const r = reader(bytes, "PE CodeView");
  assert.equal(r.slice(0, 2).toString("ascii"), "MZ");
  const pe = r.u32(0x3c);
  assert.equal(r.slice(pe, 4).toString("binary"), "PE\0\0");
  const optional = pe + 24;
  assert.equal(r.u16(optional), 0x20b, "A 64-bit PE is required");
  const sectionTable = optional + r.u16(pe + 20);
  const rva = (address) => {
    for (let i = 0; i < r.u16(pe + 6); i++) {
      const section = sectionTable + i * 40;
      const start = r.u32(section + 12);
      const size = Math.max(r.u32(section + 8), r.u32(section + 16));
      if (address >= start && address < start + size) return r.u32(section + 20) + address - start;
    }
    throw new Error("PE debug directory outside sections");
  };
  const debug = rva(r.u32(optional + 160));
  const debugSize = r.u32(optional + 164);
  for (let i = 0; i + 28 <= debugSize; i += 28) {
    if (r.u32(debug + i + 12) !== 2) continue;
    const codeview = reader(
      r.slice(r.u32(debug + i + 24), r.u32(debug + i + 16)),
      "PE CodeView record",
    );
    assert.equal(codeview.slice(0, 4).toString("ascii"), "RSDS", "Unsupported PE PDB signature");
    return { guid: codeview.slice(4, 16).toString("hex"), age: codeview.u32(20) };
  }
  throw new Error("Missing PE PDB CodeView identity");
}

export function assertPePdbBinding(binary, pdb) {
  const pe = readPePdbIdentity(binary);
  assert.deepEqual(pe, readPdbIdentity(pdb), "PE/PDB GUID or age mismatch");
  const hasCommit = (bytes) =>
    ["utf8", "utf16le"].some((encoding) => bytes.includes(Buffer.from(pins.rustCommit, encoding)));
  return {
    ...pe,
    executableCommitStringPresent: hasCommit(binary),
    pdbCommitStringPresent: hasCommit(pdb),
  };
}
