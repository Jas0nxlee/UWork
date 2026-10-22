#!/usr/bin/env node
/**
 * 把草稿渲染成**对话里的卡片**（agent 端）。
 *
 * 用法：
 *   node skills/dept-qa-report/scripts/render-card.mjs --draft /tmp/qa-draft.json
 *
 * 输出两行：① 生成的文件路径；② 供 agent **原样贴进对话**的 `::visualize` 指令。
 *
 * 为什么输出目录不让人挑（除非显式 --out）：应用只在**宿主输出根目录**
 * （env ZCODE_GEN_UI_OUTPUT_ROOT，即 <数据根>/visualizations）下读取可视化文件，
 * 写到别处（/tmp、工作区）会渲染成"指令无效"，而且是静默的——所以默认就写进去。
 * 另外该目录里的文件名必须是**小写连字符 .html**，卡片内容必须是**片段**（无
 * doctype/html/head/body）：这两条同样由应用契约强校验，这里提前拦，免得白贴一条指令。
 *
 * 卡片是只读沙箱（Gen UI 契约里只有 openExternal），所以"汇报/暂存"由用户回一句话
 * 决定——卡片底部的提示已经写明了这一点，不要指望它带按钮。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATE_DIR = join(HERE, "..");
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const FRAGMENT_TAG = /<(?:!doctype\b|\/?(?:html|head|body)(?:\s|>))/iu;

const escape = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function section(label, text, tone = "") {
  if (!text) return "";
  return `<div class="block${tone === "danger" ? " alert" : ""}"><div class="label">${escape(label)}</div><div class="text">${escape(text)}</div></div>`;
}

/** 属性值还要转义引号：提示词里带书名号、破折号是常态。 */
const escapeAttr = (value) => escape(value).replace(/"/g, "&quot;");

/**
 * 卡片底部的两个动作，**性质不同**：
 * - 「汇报」是 follow-up：让 agent 去提交（沙箱里唯一能让 agent 动的通路，宿主还会校验用户手势，
 *   没手势就退化成一次确认弹窗——所以按钮不可能自己触发 agent）。prompt 带上标题，多份草稿不混淆。
 * - 「暂存」是**纯本地**：不发消息、不叫 agent、不打模型，只在本机 widget state 的 `privateContent`
 *   里记一笔（草稿文件本来就在本机）。
 */
function actions(title) {
  return [
    `<button type="button" class="action primary" data-prompt="${escapeAttr(`汇报：${title}`)}">汇报</button>`,
    `<button type="button" class="action" data-local="stage">暂存</button>`,
  ].join("\n    ");
}

function fail(message) {
  console.error(`render-card: ${message}`);
  return 2;
}

function outside(root, file) {
  const child = relative(root, file);
  return !child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child);
}

/** 应用读取可视化文件的根目录；在 agent 会话里由宿主注入。 */
function sandboxRoot() {
  const fromEnv = process.env.ZCODE_GEN_UI_OUTPUT_ROOT;
  return fromEnv && isAbsolute(fromEnv) ? resolve(fromEnv) : undefined;
}

function resolveOutputPath(arg) {
  const root = sandboxRoot();
  const explicit = arg("out");
  if (explicit) {
    const out = resolve(explicit);
    if (!isAbsolute(explicit)) return { error: `--out 需要绝对路径：${explicit}` };
    if (!FILE_NAME.test(out.split(/[\\/]/u).at(-1) ?? ""))
      return { error: `--out 的文件名必须是小写连字符 .html（如 card-2026-10-18.html）：${out}` };
    if (root && outside(root, out))
      return {
        error: `--out 必须落在可视化根目录内，否则应用读不到、卡片不会渲染。\n  根目录：${root}`,
      };
    return { out };
  }
  if (!root)
    return {
      error: [
        "找不到 ZCODE_GEN_UI_OUTPUT_ROOT（宿主注入的变量，指明应用能读取的可视化根目录）。",
        "在应用里的 agent 会话中运行时会自动带上；在普通终端里请显式 --out 到该根目录内。",
      ].join("\n  "),
    };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").toLowerCase();
  return { out: join(root, `card-${stamp}.html`) };
}

function main(argv) {
  const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const draftPath = arg("draft");
  // 暂存箱编号（可选）：写到卡片上，用户之后能指着它说"就报那份"
  const draftId = arg("draft-id");
  if (!draftPath) {
    console.error(
      "用法：node render-card.mjs --draft <草稿.json> [--out <可视化根目录内的 .html>]",
    );
    return 2;
  }
  if (!existsSync(draftPath)) return fail(`草稿不存在：${draftPath}`);

  const target = resolveOutputPath(arg);
  if (target.error) return fail(target.error);
  const outPath = target.out;

  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, "utf8"));
  } catch (error) {
    return fail(`草稿不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!draft.title) return fail("草稿缺少 title（卡片标题，应用也会拿它做标题提示）");

  const fields = Object.entries(draft.fields ?? {}).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const attachments = draft.attachmentIds ?? [];

  const html = readFileSync(join(TEMPLATE_DIR, "card.template.html"), "utf8")
    .replaceAll("__TITLE__", escape(draft.title))
    .replaceAll("__PERIOD__", escape(draft.periodKey))
    .replaceAll(
      "__META__",
      escape([draft.projectName, draft.projectId].filter(Boolean).join(" · ") || "—"),
    )
    .replaceAll(
      "__SECTIONS__",
      [
        section("做了什么", draft.summary),
        section("详细内容", draft.content),
        section("遇到的问题", draft.problems, "danger"),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .replaceAll(
      "__FIELDS__",
      fields
        .map(
          ([key, value]) =>
            `<div class="field"><div class="k">${escape(key)}</div><div class="v">${escape(value)}</div></div>`,
        )
        .join(""),
    )
    .replaceAll(
      "__ATTACHMENTS__",
      attachments.length
        ? `<div class="att">📎 ${escape(attachments.length)} 个工作输出物</div>`
        : "",
    )
    .replaceAll("__ACTIONS__", actions(draft.title))
    // 草稿路径（本机）显示在卡片上：这样"暂存"才说得清是"留着这个文件"
    .replaceAll("__DRAFT_PATH__", escape(draftId ? `#${draftId} · ${draftPath}` : draftPath))
    .replaceAll(/__[A-Z]+__/g, "—");

  // 沙箱只接受片段；带着整篇文档结构会在渲染时才报错，这里提前失败。
  if (FRAGMENT_TAG.test(html))
    return fail("card.template.html 必须是 HTML 片段（不允许 doctype/html/head/body 标签）");

  writeFileSync(outPath, html, "utf8");
  // 第二行是给 agent 用的：原样贴进对话（不要放进代码块），应用会把它渲染成内联卡片
  console.log(outPath);
  console.log(
    `::visualize${JSON.stringify({ path: outPath, title: String(draft.title).slice(0, 250) })}`,
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
