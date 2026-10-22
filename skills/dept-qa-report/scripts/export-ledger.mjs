#!/usr/bin/env node
/**
 * 按部门模板把工作项导成 xlsx（**列顺序与表头来自 `export.columns.json`**，不是写死的）。
 *
 * 两种用法：
 *   node export-ledger.mjs --from items.json --out 台账.xlsx      # 离线（用已有数据，便于测试）
 *   node export-ledger.mjs --period 2026-10 --out 台账.xlsx        # 从服务端拉（需要宿主注入的凭据）
 *
 * 为什么导出要跟着模板走：部门改字段/改列顺序，是他们自己的事——导出跟着变，不需要我们发版。
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildXlsxBuffer } from "./xlsx-lite.mjs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATE_DIR = join(HERE, "..");

const header = (columns) => columns.map((column) => column.header);

/**
 * 人员列（项目经理 / 测试工程师 / 创建人 / 最后编辑人）导出时解析成人名。
 *
 * 为什么必须做：台账是给部门看的，`11111111-2222-…` 这种 id 他们没法用（真机导出后立刻看出来）。
 * 解析不到就**原样保留 id**——宁可露出 id，也不要编一个名字。
 */
const PERSON_FIELDS = new Set(["managerId", "engineerId", "createdBy", "updatedBy"]);

function personName(value, directory) {
  if (!value) return "";
  const name = directory?.get(String(value));
  return name ?? String(value);
}

function cellValue(attributes, field, directory) {
  if (field === "attachments") {
    return (attributes.attachmentIds ?? []).length;
  }
  // **模板字段在 `attributes.fields` 里，不在平铺属性上**（骨架字段才是平铺的）。
  // 只读平铺的代价：部门台账里"测试方式/测试数量/产品总数"这些列**一直是空的**（真机验到）。
  if (PERSON_FIELDS.has(field)) return personName(attributes[field], directory);
  const value = attributes[field] ?? attributes.fields?.[field];
  if (value === undefined || value === null) return "";
  if (typeof value === "number") {
    // 毫秒时间戳按日期输出，其余数字原样
    return value > 1e11 ? new Date(value).toISOString().slice(0, 10) : value;
  }
  if (Array.isArray(value)) return value.join("、");
  return String(value);
}

async function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const outPath = arg("out") ?? "work-items.xlsx";
  const fromPath = arg("from");
  const period = arg("period");
  // 部门汇总（可选）：负责人/管理员才拉得动；调用前先跑 rollup-scope.mjs 确认
  const department = arg("department");
  /** id → 姓名（离线模式没有目录，人员列就写 id，不编名字）。 */
  let directory;
  const columns = JSON.parse(readFileSync(join(TEMPLATE_DIR, "export.columns.json"), "utf8"));

  let items = [];
  if (fromPath) {
    const raw = JSON.parse(readFileSync(fromPath, "utf8"));
    items = (Array.isArray(raw) ? raw : (raw.data ?? [])).map((item) => item.attributes ?? item);
  } else {
    const baseUrl = process.env.UWORK_WORK_ITEM_BASE_URL?.replace(/\/$/, "");
    const token = process.env.UWORK_WORK_ITEM_TOKEN;
    if (!baseUrl || !token) {
      console.error(
        "✗ 需要 --from <items.json>，或宿主注入的 UWORK_WORK_ITEM_BASE_URL / UWORK_WORK_ITEM_TOKEN",
      );
      return 2;
    }
    const query = new URLSearchParams({
      "filter[type]": "dept.qa.test-record",
      "page[size]": "200",
    });
    if (period) query.set("filter[period]", period);
    // 部门汇总：只有该部门负责人（或平台管理员）拉得动，服务端会 403（见 specs §十四）。
    // 该不该带这个参数由调用方先问 `rollup-scope.mjs` —— 猜错的代价是"拉不到却报没有记录"。
    if (department) query.set("filter[department]", department);
    const response = await fetch(`${baseUrl}/api/work-items?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body) => body?.errors?.[0]?.detail ?? body?.message ?? "")
        .catch(() => "");
      if (response.status === 403 && department) {
        console.error(
          `✗ 你不是「${department}」的负责人，拉不到该部门的台账（这是权限，不是没有数据）`,
        );
        return 1;
      }
      console.error(`✗ 拉取失败：${response.status}${detail ? `（${detail}）` : ""}`);
      return 1;
    }
    items = ((await response.json()).data ?? []).map((item) => item.attributes);
    // 目录一次就够（名单很小）：人员列要写人名而不是 id
    const directoryResponse = await fetch(`${baseUrl}/api/directory/users?q=`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (directoryResponse.ok) {
      const body = await directoryResponse.json();
      directory = new Map((body.users ?? []).map((user) => [user.id, user.name]));
    }
  }

  // **零依赖写出**：技能装在用户技能根里跑，那里没有 node_modules，裸 import 一个包会直接
  // ERR_MODULE_NOT_FOUND（真机踩到）。见 scripts/xlsx-lite.mjs 的说明。
  const rows = [
    header(columns.columns),
    ...items.map((attributes) =>
      columns.columns.map((column) => cellValue(attributes, column.field, directory)),
    ),
  ];
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildXlsxBuffer({ sheetName: columns.sheetName ?? "工作记录", rows }));
  console.log(`✓ 导出 ${items.length} 行 → ${outPath}（表头来自 export.columns.json）`);
  return 0;
}

process.exit(await main(process.argv.slice(2)));
