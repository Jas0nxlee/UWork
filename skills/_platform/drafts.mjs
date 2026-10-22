#!/usr/bin/env node
/**
 * **本地暂存箱**：agent 产出、还没报出去（或还没定稿）的东西，落在一个标准位置，
 * 让人和 agent 之后都能**找回来**。
 *
 * 为什么要有这个通用件（2026-10-19 用户提出）：草稿原来各 skill 自己找地方放（`/tmp`、工作区里随手一个文件名），
 * 卡片上的「暂存」又只能在本机记一笔（sandbox 写不了文件），于是"我上周暂存的那份呢"根本没人能回答。
 * 这件事跟具体业务无关，所以抽到平台层：**任何 skill 都能往里暂存任何东西**，
 * 而 agent 只要 `list` 一次就能说出"有哪些还没报出去的"。
 *
 * 三条设计口径：
 * 1. **暂存＝文件已经在暂存箱里**。不存在"点一下才被记录"——`stage` 的那一刻就已经可查、可读；
 *    卡片上的「暂存」按钮只是"留着"（不删除），不需要它替谁记账。
 * 2. **状态只三态**：`staged`（还没报出去）→ `submitted`（报出去了，带业务编号）或 `dropped`（不要了）。
 *    业务细节（模板字段、审核人…）留在 `payload.json` 里，暂存箱不解释它。
 * 3. **只写自己的根目录之内**：id、kind 都做白名单校验，拒绝任何穿越路径的输入。
 *
 * 用法：
 *   node skills/_platform/drafts.mjs stage --kind <业务类型> --title <标题> [--payload <内容.json>] [--tags a,b] [--note <备注>]
 *   node skills/_platform/drafts.mjs list [--kind <业务类型>] [--status staged|submitted|dropped|all] [--limit N]
 *   node skills/_platform/drafts.mjs show <id>
 *   node skills/_platform/drafts.mjs submit <id> --item <业务编号> [--note <备注>]
 *   node skills/_platform/drafts.mjs drop <id> [--reason <原因>]
 *   node skills/_platform/drafts.mjs --self-test
 *
 * 根目录解析顺序：`UWORK_DRAFTS_DIR` → `<ZCODE_STORAGE_DIR>/drafts` → `~/.uwork/drafts`。
 * 退出码：0 成功；1 业务失败（找不到 / 状态不允许）；2 用法或输入错误。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export const DRAFTS_VERSION = 1;
const ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-z0-9][a-z0-9-]{0,47}$/;
const KIND_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const STATUSES = ["staged", "submitted", "dropped"];

export function draftsRoot(env = process.env) {
  const explicit = env.UWORK_DRAFTS_DIR?.trim();
  if (explicit && isAbsolute(explicit)) return resolve(explicit);
  const storage = env.ZCODE_STORAGE_DIR?.trim();
  if (storage && isAbsolute(storage)) return join(resolve(storage), "drafts");
  return join(homedir(), ".uwork", "drafts");
}

/** 一位 `yyyymmdd-hhmmss-<kind 的尾段>`：按时间排序天然有序，人也能看懂。 */
export function buildDraftId(now, kind) {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-")
    .toLowerCase();
  const tail = kind.split(".").at(-1) ?? "draft";
  return `${stamp}-${tail}`.slice(0, 56);
}

function assertInsideRoot(root, dir) {
  const child = resolve(dir);
  if (child !== root && !child.startsWith(`${root}${sep}`))
    throw new Error(`拒绝写到暂存箱之外：${dir}`);
  return child;
}

function draftDir(root, id) {
  if (!ID_PATTERN.test(id)) throw new Error(`草稿编号不合法：${id}`);
  return assertInsideRoot(root, join(root, id));
}

const readEnvelope = (dir) => JSON.parse(readFileSync(join(dir, "draft.json"), "utf8"));

function writeEnvelope(dir, envelope) {
  writeFileSync(join(dir, "draft.json"), `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

function listDrafts(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const name of readdirSync(root)) {
    if (!ID_PATTERN.test(name)) continue;
    const dir = join(root, name);
    if (!existsSync(join(dir, "draft.json"))) continue;
    try {
      entries.push({ id: name, ...readEnvelope(dir) });
    } catch {
      // 坏信封跳过：一个损坏的草稿不该让整个清单读不出来
    }
  }
  return entries.sort((left, right) => right.id.localeCompare(left.id));
}

const stamp = (iso) =>
  String(iso ?? "")
    .replace("T", " ")
    .slice(0, 16);

export function stage(input, env = process.env) {
  if (!KIND_PATTERN.test(input.kind)) throw new Error(`业务类型不合法：${input.kind}`);
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("标题不能为空（人和 agent 都靠它认东西）");
  const root = draftsRoot(env);
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  // 编号精确到秒，同一秒里 stage 两次会撞号——撞了就必须换一个，**不能覆盖**（那会静默吃掉前一份草稿）
  let id = buildDraftId(now, input.kind);
  for (let attempt = 2; existsSync(join(root, id)) && attempt < 100; attempt += 1)
    id = `${buildDraftId(now, input.kind)}-${attempt}`;
  const dir = draftDir(root, id);
  mkdirSync(dir);
  const payloadPath = join(dir, "payload.json");
  if (input.payloadPath) {
    // 业务内容原样搬进来：暂存箱不解释它，但必须在自己目录里（不能只留一个会消失的引用路径）
    writeFileSync(payloadPath, readFileSync(input.payloadPath));
  }
  writeEnvelope(dir, {
    version: DRAFTS_VERSION,
    kind: input.kind,
    title,
    status: "staged",
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    submission: null,
    tags: input.tags ?? [],
    note: input.note ?? null,
    ...(input.payloadPath ? { payload: "payload.json" } : {}),
  });
  return { id, dir, payloadPath: input.payloadPath ? payloadPath : null };
}

export function updateStatus(id, patch, env = process.env) {
  const dir = draftDir(draftsRoot(env), id);
  if (!existsSync(join(dir, "draft.json"))) throw new Error(`没有这个草稿：${id}`);
  const envelope = readEnvelope(dir);
  if (!STATUSES.includes(patch.status)) throw new Error(`状态不合法：${patch.status}`);
  const next = {
    ...envelope,
    status: patch.status,
    updatedAt: new Date().toISOString(),
    ...(patch.status === "submitted"
      ? { submittedAt: new Date().toISOString(), submission: patch.submission ?? null }
      : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
  };
  writeEnvelope(dir, next);
  return { id, dir, envelope: next };
}

export function readDraft(id, env = process.env) {
  const dir = draftDir(draftsRoot(env), id);
  if (!existsSync(join(dir, "draft.json"))) throw new Error(`没有这个草稿：${id}`);
  return { id, dir, envelope: readEnvelope(dir) };
}

const line = (draft) =>
  `#${draft.id}  ${stamp(draft.createdAt)}  [${draft.status}]  ${draft.title}  · ${draft.kind}`;

function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const command = argv[0];
  const env = process.env;

  if (argv.includes("--self-test")) {
    console.log(`暂存箱根目录：${draftsRoot(env)}`);
    console.log("（--self-test 只打印解析结果；写读的验证在单测里做，避免污染真实暂存箱）");
    return 0;
  }

  try {
    if (command === "stage") {
      const payload = arg("payload");
      const result = stage(
        {
          kind: arg("kind") ?? "",
          title: arg("title") ?? "",
          ...(payload ? { payloadPath: payload } : {}),
          tags: (arg("tags") ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          ...(arg("note") ? { note: arg("note") } : {}),
        },
        env,
      );
      console.log(`✓ 已暂存 #${result.id}：${arg("title")}`);
      console.log(`  位置：${result.dir}`);
      if (result.payloadPath) console.log(`  业务内容：${result.payloadPath}`);
      console.log(`  之后要找回：node skills/_platform/drafts.mjs list --status staged`);
      return 0;
    }

    if (command === "list") {
      const kind = arg("kind");
      const status = arg("status") ?? "staged";
      const limit = Number(arg("limit") ?? 20);
      const drafts = listDrafts(draftsRoot(env)).filter(
        (draft) =>
          (status === "all" || draft.status === status) &&
          (kind ? draft.kind.startsWith(kind) : true),
      );
      if (drafts.length === 0) {
        console.log(
          status === "staged" ? "暂存箱里没有还没报出去的草稿" : `没有 ${status} 状态的草稿`,
        );
        return 0;
      }
      console.log(`共 ${drafts.length} 条${status === "all" ? "" : `（${status}）`}：`);
      for (const draft of drafts.slice(0, Number.isFinite(limit) ? limit : 20))
        console.log(line(draft));
      return 0;
    }

    if (command === "show") {
      const id = argv[1];
      if (!id) throw new Error("用法：show <id>");
      const { dir, envelope } = readDraft(id, env);
      console.log(`#${id}  ${envelope.title}`);
      console.log(`  业务类型：${envelope.kind}`);
      console.log(`  状态：${envelope.status}（创建 ${stamp(envelope.createdAt)}）`);
      if (envelope.submittedAt) console.log(`  报出时间：${stamp(envelope.submittedAt)}`);
      if (envelope.submission) console.log(`  业务编号：${JSON.stringify(envelope.submission)}`);
      if (envelope.note) console.log(`  备注：${envelope.note}`);
      console.log(`  位置：${dir}${envelope.payload ? `（业务内容 ${envelope.payload}）` : ""}`);
      return 0;
    }

    if (command === "submit" || command === "drop") {
      const id = argv[1];
      if (!id) throw new Error(`用法：${command} <id>`);
      const result =
        command === "submit"
          ? updateStatus(
              id,
              {
                status: "submitted",
                submission: { item: arg("item") ?? null, by: "agent" },
                ...(arg("note") ? { note: arg("note") } : {}),
              },
              env,
            )
          : updateStatus(
              id,
              { status: "dropped", ...(arg("reason") ? { note: arg("reason") } : {}) },
              env,
            );
      console.log(
        command === "submit"
          ? `✓ 已标记报出 #${id}${arg("item") ? `（业务编号 ${arg("item")}）` : ""}`
          : `✓ 已标记丢弃 #${id}`,
      );
      console.log(`  位置：${result.dir}`);
      return 0;
    }

    if (command === "prune") {
      // 清掉已丢弃的（只删 dropped：staged 是还没报的、submitted 是记录，都不能悄悄删）
      const root = draftsRoot(env);
      const dropped = listDrafts(root).filter((draft) => draft.status === "dropped");
      for (const draft of dropped)
        rmSync(draftDir(root, draft.id), { recursive: true, force: true });
      console.log(`✓ 清掉 ${dropped.length} 条已丢弃的草稿`);
      return 0;
    }

    console.error(
      [
        "用法：",
        "  drafts.mjs stage --kind <业务类型> --title <标题> [--payload <内容.json>] [--tags a,b] [--note <备注>]",
        "  drafts.mjs list [--kind <业务类型>] [--status staged|submitted|dropped|all] [--limit N]",
        "  drafts.mjs show <id>",
        "  drafts.mjs submit <id> --item <业务编号>",
        "  drafts.mjs drop <id> [--reason <原因>]",
        "  drafts.mjs prune                       # 只清 dropped",
      ].join("\n"),
    );
    return 2;
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof Error && /不合法|不能为空/.test(error.message) ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  process.exit(main(process.argv.slice(2)));
