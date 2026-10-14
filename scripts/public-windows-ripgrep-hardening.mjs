import { readFile } from "node:fs/promises";
import { verifyWindowsPeBinary } from "./native-search-tools-windows-pe.mjs";

export function parsePublicWindowsPeHardening(bytes) {
  const u16 = (offset) => {
    if (offset < 0 || offset + 2 > bytes.length) throw new Error("Truncated PE");
    return bytes.readUInt16LE(offset);
  };
  const u32 = (offset) => {
    if (offset < 0 || offset + 4 > bytes.length) throw new Error("Truncated PE");
    return bytes.readUInt32LE(offset);
  };
  if (bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Not a PE executable");
  const pe = u32(0x3c);
  if (bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("Invalid PE signature");
  const optional = pe + 24;
  if (u16(optional) !== 0x20b) throw new Error("A 64-bit PE is required");
  const sectionCount = u16(pe + 6);
  const sectionTable = optional + u16(pe + 20);
  const rva = (value) => {
    for (let index = 0; index < sectionCount; index++) {
      const offset = sectionTable + index * 40;
      const size = Math.max(u32(offset + 8), u32(offset + 16));
      const address = u32(offset + 12);
      if (value >= address && value < address + size) return u32(offset + 20) + value - address;
    }
    throw new Error("PE data is outside mapped sections");
  };
  const directory = optional + 112;
  const loadRva = u32(directory + 80);
  const loadSize = u32(directory + 84);
  if (!loadRva || loadSize < 148) throw new Error("Missing CFG load config");
  const load = rva(loadRva);
  const pointer = (offset) => {
    if (offset + 8 > bytes.length) throw new Error("Truncated PE pointer");
    return bytes.readBigUInt64LE(offset).toString();
  };
  const debugRva = u32(directory + 48);
  const debugSize = u32(directory + 52);
  let extendedDllCharacteristics = 0;
  if (debugRva) {
    const start = rva(debugRva);
    for (let offset = start; offset + 28 <= start + debugSize; offset += 28) {
      if (u32(offset + 12) === 20 && u32(offset + 16) >= 4)
        extendedDllCharacteristics |= u32(u32(offset + 24));
    }
  }
  return {
    machine: u16(pe + 4),
    dllCharacteristics: u16(optional + 70),
    guardFlags: u32(load + 144),
    securityCookie: pointer(load + 88),
    guardCheckFunction: pointer(load + 112),
    guardDispatchFunction: pointer(load + 120),
    guardFunctionTable: pointer(load + 128),
    guardFunctionCount: pointer(load + 136),
    extendedDllCharacteristics,
  };
}

export function assertPublicWindowsPeHardening(metadata, arch) {
  if (metadata.machine !== (arch === "arm64" ? 0xaa64 : 0x8664))
    throw new Error("Native PE architecture mismatch");
  // Original Microsoft binaries have DLL flags 0xc160 and GuardFlags 0x10017500.
  // Require ASLR/NX/high-entropy/CFG and actual CFG instrumentation/table, not just a linker label.
  const requiredDllFlags = 0xc160;
  if ((metadata.dllCharacteristics & requiredDllFlags) !== requiredDllFlags)
    throw new Error("Missing ASLR/NX/CFG PE flags");
  if (
    (metadata.guardFlags & 0x17500) !== 0x17500 ||
    [
      metadata.guardFunctionCount,
      metadata.guardCheckFunction,
      metadata.guardDispatchFunction,
      metadata.guardFunctionTable,
    ].some((value) => value === "0" || value === undefined)
  )
    throw new Error("Missing enforced CFG instrumentation/function table");
  if (metadata.securityCookie === "0") throw new Error("Missing native security cookie");
  if (arch === "x64" && (metadata.extendedDllCharacteristics & 1) !== 1)
    throw new Error("Missing x64 CET compatibility");
  return metadata;
}

export async function verifyPublicWindowsPeHardening(binaryPath, arch) {
  verifyWindowsPeBinary(binaryPath, arch);
  return assertPublicWindowsPeHardening(
    parsePublicWindowsPeHardening(await readFile(binaryPath)),
    arch,
  );
}
