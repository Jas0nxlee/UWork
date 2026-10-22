#!/usr/bin/env node
/**
 * 工作项模板契约的**唯一实现**：既校验模板本身，也校验一份要提交的内容。
 *
 * 为什么只有一份：契约（`work-item-contract.v1.json`）是平台定义的单一来源，
 * 而"部门本地编辑 → agent 填卡前 → 服务端入库前"三处必须用同一套判断，
 * 否则就会出现"本地过了、服务端拒了"或者反过来（更糟：两边都以为对方管）。
 *
 * 用法：
 *   node skills/_platform/work-item-contract.mjs --template <模板目录>
 *   node skills/_platform/work-item-contract.mjs --template <模板目录> --payload <payload.json>
 *   node skills/_platform/work-item-contract.mjs --self-test
 *
 * 退出码：0 通过；1 有错误；2 用法/读取错误。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CONTRACT_PATH = join(HERE, "work-item-contract.v1.json");

export function loadContract(path = CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** 允许的校验器：白名单之外一律拒绝（契约 §四）。 */
export function validateTemplate(templateDir, contract = loadContract()) {
  const errors = [];
  const warnings = [];
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(join(templateDir, name), "utf8"));
    } catch (error) {
      errors.push(`${name}: 读不到或不是合法 JSON（${error.message}）`);
      return null;
    }
  };

  const schema = read("schema.json");
  const vocabulary = read("vocabulary.json");
  const exportColumns = read("export.columns.json");
  if (!schema || !vocabulary) return { errors, warnings };

  // 1) 契约版本
  if (schema.contractVersion !== contract.contractVersion) {
    errors.push(
      `schema.json: contractVersion=${schema.contractVersion}，当前平台契约是 v${contract.contractVersion}（请按 PLATFORM-CONTRACT.md 升级）`,
    );
  }

  // 2) 模板必须声明 id/version（版本冻结靠它，见契约 §五）
  if (!schema.templateId) errors.push("schema.json: 缺 templateId");
  if (!Number.isInteger(schema.templateVersion))
    errors.push("schema.json: templateVersion 必须是整数（改了就递增）");
  if (!schema.periodFormat) errors.push("schema.json: 缺 periodFormat（YYYY-MM 或 YYYY-Www）");
  else if (!contract.periodFormats.includes(schema.periodFormat)) {
    errors.push(
      `schema.json: periodFormat=${schema.periodFormat} 不在允许集合 ${contract.periodFormats.join(" / ")}`,
    );
  }
  if (schema.title && schema.title.length === 0) errors.push("schema.json: title 为空");

  // 3) 字段：不得与骨架冲突、不得超上限、校验器必须白名单内
  const skeleton = new Set(contract.skeletonFields.map((field) => field.name));
  const fields = schema.fields ?? [];
  if (!Array.isArray(fields)) errors.push("schema.json: fields 必须是数组");
  else {
    if (fields.length > contract.limits.maxFields) {
      errors.push(
        `schema.json: fields 有 ${fields.length} 项，超过上限 ${contract.limits.maxFields}`,
      );
    }
    const seen = new Set();
    for (const [index, field] of fields.entries()) {
      const where = `schema.json: fields[${index}]`;
      if (!isObject(field) || typeof field.name !== "string" || field.name.length === 0) {
        errors.push(`${where}: 缺 name`);
        continue;
      }
      if (skeleton.has(field.name)) {
        errors.push(
          `${where}: name="${field.name}" 与**骨架字段**重名——骨架字段由平台定义（契约 §一），部门只能追加新字段`,
        );
      }
      if (seen.has(field.name)) errors.push(`${where}: name="${field.name}" 重复`);
      seen.add(field.name);
      if (!field.label) errors.push(`${where}: 缺 label（导出表头要用）`);
      if (typeof field.label === "string" && field.label.length > contract.limits.maxFieldLabel) {
        errors.push(`${where}: label 超过 ${contract.limits.maxFieldLabel} 字符`);
      }
      for (const [validator, value] of Object.entries(field)) {
        if (["name", "label", "type", "description"].includes(validator)) continue;
        if (!(validator in contract.validators)) {
          errors.push(`${where}: 校验器 "${validator}" 不在白名单内（契约 §四）`);
          continue;
        }
        if (contract.validators[validator] === false) {
          errors.push(`${where}: 校验器 "${validator}" 被平台禁用（不允许自带脚本/表达式）`);
        }
        if (validator === "oneOf") {
          const list = vocabulary[value];
          if (!Array.isArray(list)) {
            errors.push(`${where}: oneOf="${value}" 在 vocabulary.json 里不存在`);
          } else if (list.length > contract.limits.maxVocabularyValues) {
            errors.push(
              `${where}: 词表 "${value}" 有 ${list.length} 个取值，超过上限 ${contract.limits.maxVocabularyValues}`,
            );
          }
        }
        if (validator === "length" && isObject(value) && value.max > contract.limits.maxFieldText) {
          errors.push(
            `${where}: length.max=${value.max} 超过平台上限 ${contract.limits.maxFieldText}`,
          );
        }
      }
    }
  }

  // 4) 词表：上限 + 用过的不许删（这里只能查"是否有值被标删除"这种显式写法）
  for (const [name, values] of Object.entries(vocabulary)) {
    // 下划线开头是给写模板的人留的说明位（JSON 没有注释）——忽略，不当词表
    if (name.startsWith("_")) continue;
    if (!Array.isArray(values)) {
      errors.push(`vocabulary.json: "${name}" 必须是数组`);
      continue;
    }
    if (values.length > contract.limits.maxVocabularyValues) {
      errors.push(
        `vocabulary.json: "${name}" 有 ${values.length} 个取值，超过上限 ${contract.limits.maxVocabularyValues}`,
      );
    }
    if (values.some((value) => !value || typeof value !== "string")) {
      errors.push(`vocabulary.json: "${name}" 里有非字符串取值`);
    }
  }

  // 5) 导出列：必须能映射到骨架或 fields（否则导出会缺列/错列）
  if (exportColumns) {
    const declared = new Set([...skeleton, ...fields.map((field) => field?.name).filter(Boolean)]);
    for (const column of exportColumns.columns ?? []) {
      if (!declared.has(column.field)) {
        errors.push(`export.columns.json: 列 "${column.field}" 既不是骨架字段也不是模板字段`);
      }
    }
  } else {
    warnings.push("export.columns.json: 缺（导出会退回默认列顺序）");
  }

  // 6) 包体积
  let bytes = 0;
  for (const file of readdirSync(templateDir)) {
    const stat = statSync(join(templateDir, file));
    if (stat.isFile()) bytes += stat.size;
  }
  if (bytes > contract.limits.maxPackageBytes) {
    errors.push(`模板包 ${bytes} 字节，超过上限 ${contract.limits.maxPackageBytes}`);
  }

  return { errors, warnings, template: { schema, vocabulary } };
}

/** 校验一份待提交内容：字段取值必须符合模板声明（这是 agent 提交前的自查）。 */
export function validatePayload(payload, template, contract = loadContract()) {
  const errors = [];
  if (!isObject(payload)) return { errors: ["payload 必须是对象"] };
  const schema = template.schema ?? template;
  const vocabulary = template.vocabulary ?? {};

  const skeleton = new Set(contract.skeletonFields.map((field) => field.name));
  for (const requiredName of ["type", "periodKey", "title"]) {
    if (!payload[requiredName] || typeof payload[requiredName] !== "string") {
      errors.push(`payload: 缺 ${requiredName}（骨架必填）`);
    }
  }
  if (typeof payload.periodKey === "string" && schema.periodFormat) {
    const ok =
      schema.periodFormat === "YYYY-MM"
        ? /^\d{4}-\d{2}$/.test(payload.periodKey)
        : /^\d{4}-W\d{2}$/.test(payload.periodKey);
    if (!ok) errors.push(`payload: periodKey="${payload.periodKey}" 不符合 ${schema.periodFormat}`);
  }
  if (payload.tags !== undefined) {
    if (!Array.isArray(payload.tags)) errors.push("payload: tags 必须是数组");
    else if (payload.tags.length > contract.limits.maxTags) {
      errors.push(
        `payload: tags 有 ${payload.tags.length} 项，超过上限 ${contract.limits.maxTags}`,
      );
    }
  }

  const fields = payload.fields ?? {};
  if (!isObject(fields)) errors.push("payload: fields 必须是对象");
  const declared = new Map((schema.fields ?? []).map((field) => [field.name, field]));
  for (const [name, value] of Object.entries(fields)) {
    const field = declared.get(name);
    if (!field) {
      errors.push(
        skeleton.has(name)
          ? `payload.fields.${name}: 这是**骨架字段**——骨架字段直接放在顶层，不要塞进 fields`
          : `payload.fields.${name}: 模板里没有这个字段（模板只允许声明过的字段）`,
      );
      continue;
    }
    if (value === undefined || value === null || value === "") {
      if (field.required) errors.push(`payload.fields.${name}: 必填`);
      continue;
    }
    if (typeof value === "string" && value.length > contract.limits.maxFieldText) {
      errors.push(`payload.fields.${name}: 超过 ${contract.limits.maxFieldText} 字符`);
    }
    if (field.oneOf) {
      const list = vocabulary[field.oneOf] ?? [];
      if (!list.includes(value)) {
        errors.push(
          `payload.fields.${name}: "${value}" 不在词表 ${field.oneOf} 内（可选值：${list.slice(0, 5).join("、")}${list.length > 5 ? "…" : ""}）`,
        );
      }
    }
    if (
      field.length &&
      typeof value === "string" &&
      field.length.max &&
      value.length > field.length.max
    ) {
      errors.push(`payload.fields.${name}: 超过模板上限 ${field.length.max} 字符`);
    }
    if (field.pattern && typeof value === "string" && !new RegExp(field.pattern, "u").test(value)) {
      errors.push(`payload.fields.${name}: 不符合格式 ${field.pattern}`);
    }
  }
  for (const [name, field] of declared) {
    if (
      field.required &&
      (fields[name] === undefined || fields[name] === null || fields[name] === "")
    ) {
      errors.push(`payload.fields.${name}: 必填（模板要求）`);
    }
  }
  for (const name of Object.keys(payload)) {
    if (name.startsWith("_")) continue; // 说明位（见例子的 _comment）
    if (
      skeleton.has(name) ||
      [
        "type",
        "fields",
        "tags",
        "attachmentIds",
        "recipientIds",
        "refIds",
        "templateId",
        "templateVersion",
      ].includes(name)
    ) {
      continue;
    }
    errors.push(
      declared.has(name)
        ? `payload.${name}: 这是模板字段，应该放进 fields（顶层只放骨架字段与 type/tags/…）`
        : `payload.${name}: 未知字段（骨架字段与 fields 之外的键不接受）`,
    );
  }
  return { errors };
}

function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const templateDir = arg("template");
  const payloadPath = arg("payload");
  if (!templateDir) {
    console.error(
      "用法：node work-item-contract.mjs --template <模板目录> [--payload <内容.json>]",
    );
    return 2;
  }
  const contract = loadContract();
  const template = validateTemplate(templateDir, contract);
  const label = `模板 ${templateDir}`;

  if (payloadPath) {
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    const { errors } = validatePayload(payload, template.template ?? template, contract);
    for (const error of errors) console.error(`✗ ${error}`);
    for (const warning of template.warnings) console.warn(`! ${warning}`);
    if (errors.length === 0) {
      console.log(`✓ 内容符合 ${label}（契约 v${contract.contractVersion}）`);
      return 0;
    }
    console.error(`✗ 共 ${errors.length} 处不符合，修好再提交`);
    return 1;
  }

  for (const error of template.errors) console.error(`✗ ${error}`);
  for (const warning of template.warnings) console.warn(`! ${warning}`);
  if (template.errors.length === 0) {
    console.log(
      `✓ ${label} 合法（契约 v${contract.contractVersion}，字段 ${template.template?.schema?.fields?.length ?? 0} 个）`,
    );
    return 0;
  }
  console.error(`✗ ${label} 有 ${template.errors.length} 处不符合契约，见 PLATFORM-CONTRACT.md`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("work-item-contract.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
