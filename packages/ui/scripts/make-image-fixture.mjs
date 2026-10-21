/**
 * 生成"插入图片"回归用的小样本（240×120 彩色渐变 PNG）。
 *
 * 为什么要脚本生成而不是手工放一张图：图片是二进制产物，评审看不到 diff；用脚本生成保证
 * 任何人可以复现同一份字节（确定性：无时间戳、无随机数）。运行：
 *
 *   node packages/ui/scripts/make-image-fixture.mjs
 *
 * 产物：packages/ui/test/fixtures/office-editor-image.png（被 check-office-editor-behavior.mjs
 * 与 check-office-ribbon-layout.mjs 引用）。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const target = join(repoRoot, "packages/ui/test/fixtures/office-editor-image.png");

const WIDTH = 240;
const HEIGHT = 120;

/** 每行前面有一个 filter 字节（0 = None），后面是 RGB 三通道。 */
function rawPixels() {
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowStart = y * (WIDTH * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = Math.round((x * 255) / WIDTH);
      raw[offset + 1] = Math.round((y * 255) / HEIGHT);
      raw[offset + 2] = 128;
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // color type: truecolor

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(rawPixels())),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(`已生成 ${target}（${png.length} 字节，${WIDTH}×${HEIGHT}）`);
