#!/usr/bin/env node
/**
 * **零依赖的 xlsx 写出器**（够用就好的那一小块）。
 *
 * 为什么不用 `exceljs`：技能是装在**用户技能根**（`~/.uwork/skills/...`）里被 agent 运行的，
 * 那里没有 `node_modules`——裸 import 一个包会直接 `ERR_MODULE_NOT_FOUND`（真机踩到：
 * 负责人要导出部门台账，脚本报"Cannot find package 'exceljs'"）。技能包能带的东西只有 `.mjs` 自己，
 * 所以这里用 Node 内置能力手写最小 xlsx（zip + XML，**不压缩**存条目，Excel 照开）。
 *
 * 支持：一个工作表、表头 + 数据行、数值列按数字写（不是文本）、UTF-8 中文。
 * 不支持（也不需要）：样式、公式、多表、自动列宽。
 */
import { deflateRawSync } from "node:zlib";

/** CRC32（zip 要求）——表驱动实现，够快也够短。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 0 → A，25 → Z，26 → AA。 */
function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const rest = (value - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** 单元格：数值写成数值（Excel 里能求和），其余写成内联字符串。 */
function cell(reference, value) {
  if (typeof value === "number" && Number.isFinite(value))
    return `<c r="${reference}"><v>${value}</v></c>`;
  if (value === null || value === undefined || value === "") return `<c r="${reference}"/>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => cell(`${columnName(columnIndex)}${rowIndex + 1}`, value))
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** 最小样式表：没有它 Excel 也认，但带上更保险（有些解析器会挑）。 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

/** zip 条目：存储（不压缩）——文件小、实现短，Excel/预览都能开。 */
function zipEntry(name, content) {
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 名字
  header.writeUInt16LE(0, 8); // 存储
  header.writeUInt16LE(0, 10); // 时间
  header.writeUInt16LE(0x21, 12); // 日期（1980-01-01，占位即可）
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return { name: nameBytes, data, header, offset: 0 };
}

export function buildXlsxBuffer({ sheetName = "Sheet1", rows }) {
  const files = [
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["xl/workbook.xml", workbookXml(sheetName)],
    ["xl/_rels/workbook.xml.rels", WORKBOOK_RELS],
    ["xl/styles.xml", STYLES],
    ["xl/worksheets/sheet1.xml", sheetXml(rows)],
  ];
  const entries = [];
  let offset = 0;
  for (const [name, content] of files) {
    const entry = zipEntry(name, content);
    entry.offset = offset;
    entries.push(entry);
    offset += entry.header.length + entry.name.length + entry.data.length;
  }
  const central = [];
  for (const entry of entries) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc32(entry.data), 16);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(entry.name.length, 28);
    record.writeUInt32LE(entry.offset, 42);
    central.push(record, entry.name);
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([
    ...entries.flatMap((entry) => [entry.header, entry.name, entry.data]),
    ...central,
    end,
  ]);
}

/** 压缩版（大表更有用；当前导出用不到，留给以后）。 */
export const zipEntryDeflated = (name, content) => {
  const raw = deflateRawSync(Buffer.from(content, "utf8"));
  return { name, raw };
};
