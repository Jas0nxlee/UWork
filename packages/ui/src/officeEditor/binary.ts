/** base64 ↔ ArrayBuffer：编辑位与写回路径都要用（含分块，避免大文档爆栈）。 */
export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + step)));
  }
  return btoa(binary);
}
