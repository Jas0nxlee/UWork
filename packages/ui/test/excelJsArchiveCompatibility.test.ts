import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, type Duplex } from "node:stream";
import { afterEach, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";

// 修复依据：测试必须解析 ExcelJS 实际使用的传递依赖，避免只验证根目录另一个版本。
const requireFromExcel = createRequire(createRequire(import.meta.url).resolve("exceljs"));
const unzipper = requireFromExcel("unzipper");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("ExcelJS 的 XLSX 内存读写和流式读取保持值、公式及行顺序", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Name", "Count", "Total"]);
  sheet.addRow(["中文", 42, { formula: "B2*2", result: 84 }]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  expect(restored.getWorksheet("Data")?.getCell("A2").value).toBe("中文");
  expect(restored.getWorksheet("Data")?.getCell("C2").value).toEqual({
    formula: "B2*2",
    result: 84,
  });
  // ExcelJS 自己生成的 ZIP 顺序随异步打包而变化；固定 workbook 元数据最后到达，覆盖真实乱序输入。
  const archive = await JSZip.loadAsync(bytes);
  const lateMetadata = new JSZip();
  const names = Object.keys(archive.files)
    .filter((name) => !archive.files[name]!.dir && name !== "xl/workbook.xml")
    .sort();
  for (const name of [...names, "xl/workbook.xml"])
    lateMetadata.file(name, await archive.file(name)!.async("nodebuffer"), {
      createFolders: false,
    });
  const streamBytes = await lateMetadata.generateAsync({ type: "nodebuffer" });
  const values = [];
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([streamBytes]), {
    sharedStrings: "cache",
    worksheets: "emit",
  });
  for await (const page of reader) for await (const row of page) values.push(row.values);
  expect(values).toEqual([
    [undefined, "Name", "Count", "Total"],
    [undefined, "中文", 42, { formula: "B2*2", result: 84 }],
  ]);
});

it.each(["stream", "directory"])("%s 解包拒绝兄弟前缀越界，保留正常文件", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "uwork-excel-unzip-"));
  directories.push(root);
  const destination = join(root, "dest");
  const escaped = join(root, "dest-evil", "escaped.txt");
  const zip = new JSZip();
  zip.file("safe.txt", "valid");
  zip.file("../dest-evil/escaped.txt", "must not escape");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  if (mode === "stream")
    await Readable.from([bytes])
      .pipe(unzipper.Extract({ path: destination }))
      .promise();
  else await (await unzipper.Open.buffer(bytes)).extract({ path: destination });
  expect(await readFile(join(destination, "safe.txt"), "utf8")).toBe("valid");
  await expect(access(escaped)).rejects.toMatchObject({ code: "ENOENT" });
});

async function simpleArchive(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("first.txt", "first");
  zip.file("last.txt", "last");
  return zip.generateAsync({ type: "nodebuffer" });
}

async function consumeForceStream(
  bytes: Buffer,
  options: { chunkSize?: number; cancelAfterFirst?: boolean } = {},
) {
  const parser: Duplex = unzipper.Parse({ forceStream: true });
  const events: string[] = [];
  const entries: Array<{ path: string; contents: string }> = [];
  for (const event of ["finish", "end", "close"]) parser.on(event, () => events.push(event));
  const chunkSize = options.chunkSize ?? bytes.length;
  const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) =>
    bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
  );
  const source = Readable.from(chunks);
  source.pipe(parser);
  try {
    for await (const entry of parser) {
      entries.push({ path: entry.path, contents: (await entry.buffer()).toString("utf8") });
      if (options.cancelAfterFirst) parser.destroy(new Error("archive-consumption-cancelled"));
    }
    return { entries, events };
  } finally {
    source.destroy();
    parser.destroy();
  }
}

it.each([
  ["单块", {}],
  ["7 字节分块", { chunkSize: 7 }],
] as const)("forceStream %s 完整交付尾项，只由可读侧终结一次", async (_description, options) => {
  const result = await consumeForceStream(await simpleArchive(), options);
  expect(result.entries).toEqual([
    { path: "first.txt", contents: "first" },
    { path: "last.txt", contents: "last" },
  ]);
  expect(result.events).toEqual(["finish", "end", "close"]);
});

it("forceStream 截断 central directory 必须失败，不能伪装为已读完", async () => {
  const bytes = await simpleArchive();
  await expect(consumeForceStream(bytes.subarray(0, bytes.length - 8))).rejects.toThrow(
    "FILE_ENDED",
  );
});

it("forceStream 非法 ZIP 签名明确报错", async () => {
  await expect(consumeForceStream(Buffer.from("not a zip"))).rejects.toThrow("invalid signature");
});

it("forceStream 消费首项后显式取消，以取消错误终结", async () => {
  await expect(
    consumeForceStream(await simpleArchive(), { cancelAfterFirst: true }),
  ).rejects.toThrow("archive-consumption-cancelled");
});
