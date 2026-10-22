#!/usr/bin/env node
/**
 * 提交一条工作记录（工作项）。
 *
 * **先本地校验，再提交**：本地那次只是省往返（用 `_platform/work-item-contract.mjs`），
 * 服务端会用同一套规则再验一次——以服务端为准。
 *
 * 环境（由宿主提供，agents 不要打印它们）：
 *   UWORK_WORK_ITEM_BASE_URL   网关基址，如 https://pivot.ucas.com.cn:23090
 *   UWORK_WORK_ITEM_TOKEN      当前登录用户的令牌（**窄能力，仅用于工作项接口**）
 *
 * 用法：
 *   node submit-work-item.mjs --draft /tmp/qa-draft.json [--dry-run]
 *
 * 退出码：0 成功；1 校验/服务端拒绝；2 用法或凭据缺失。
 */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  loadContract,
  validatePayload,
  validateTemplate,
} from "../../_platform/work-item-contract.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATE_DIR = join(HERE, "..");
const DRAFTS = join(HERE, "..", "..", "_platform", "drafts.mjs");

/** 调平台暂存箱（同一个实现，不在这里重造规则）。 */
function runDrafts(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [DRAFTS, ...args], (error, stdout, stderr) =>
      resolve({
        ok: !error,
        message: (stderr || stdout || (error && error.message) || "").trim().split("\n").at(-1),
      }),
    );
  });
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const draftPath = argv[argv.indexOf("--draft") + 1];
  // 暂存箱里的草稿编号（`drafts.mjs stage` 打印过）：提交成功后据此把那条标成"已报出"。
  const draftId = argv.includes("--draft-id") ? argv[argv.indexOf("--draft-id") + 1] : undefined;
  if (!draftPath || draftPath.startsWith("--")) {
    console.error(
      "用法：node submit-work-item.mjs --draft <草稿.json> [--draft-id <草稿编号>] [--dry-run]",
    );
    return 2;
  }

  const contract = loadContract();
  const template = validateTemplate(TEMPLATE_DIR, contract);
  if (template.errors.length > 0) {
    console.error("✗ 模板本身不合法，先修模板（不要在内容层绕过）：");
    for (const error of template.errors) console.error(`  ${error}`);
    return 1;
  }

  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  const local = validatePayload(draft, template.template, contract);
  if (local.errors.length > 0) {
    console.error("✗ 本地校验未通过（修好再提交）：");
    for (const error of local.errors) console.error(`  ${error}`);
    return 1;
  }
  console.log("✓ 本地校验通过");

  if (dryRun) {
    console.log("（--dry-run：不提交）");
    return 0;
  }

  const baseUrl = process.env.UWORK_WORK_ITEM_BASE_URL?.replace(/\/$/, "");
  const token = process.env.UWORK_WORK_ITEM_TOKEN;
  if (!baseUrl || !token) {
    console.error(
      "✗ 缺少 UWORK_WORK_ITEM_BASE_URL / UWORK_WORK_ITEM_TOKEN——这两个由宿主注入（窄能力），不要在命令行里手传令牌。",
    );
    return 2;
  }

  // 模板随请求一起送：服务端据它做**事实边界**校验（模板是不是最新版由部门自己保证）
  const body = {
    ...draft,
    template: { ...template.template.schema, vocabulary: template.template.vocabulary },
  };
  const response = await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = (parsed.errors ?? []).map((error) => error.detail).join("; ") || text;
    } catch {
      // 保持原文
    }
    console.error(`✗ 服务端拒绝（${response.status}）：${detail}`);
    return 1;
  }
  const payload = JSON.parse(text);
  const attributes = payload.data?.attributes ?? {};

  // **默认输出人话**：这段会直接出现在用户的对话里，JSON 会让人以为"报错了"。
  // 需要机器可读时用 `--json`（脚本、练习、排障）。
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          id: payload.data?.id,
          type: attributes.type,
          periodKey: attributes.periodKey,
          title: attributes.title,
          validation: attributes.validation,
          reviewers: attributes.recipientIds ?? [],
          resolvedBy: payload.meta?.resolvedBy ?? null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const RULE_LABEL = {
    record: "提交时指定",
    author: "按你的个人规则",
    project: "按项目规则",
    template: "按模板规则",
    department: "按部门规则",
    wecom: "按部门负责人兜底",
    ask: "需要你指定",
  };
  const reviewers = payload.meta?.resolvedReviewers ?? attributes.recipientIds ?? [];
  // 目录 id → 人名：用户在对话里看到的应该是名字。取不到就退回 id（不因为一次目录请求失败而让整条输出变形）。
  const nameOf = async (ids) => {
    if (ids.length === 0) return [];
    try {
      const res = await fetch(`${baseUrl}/api/directory/users`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return ids;
      const users = (await res.json()).users ?? [];
      const byId = new Map(users.map((user) => [user.id, user.name ?? user.id]));
      return ids.map((id) => byId.get(id) ?? id);
    } catch {
      return ids;
    }
  };
  const reviewerNames = await nameOf(reviewers);
  const rule = RULE_LABEL[payload.meta?.resolvedBy ?? ""] ?? "未指定规则";
  console.log(`✓ 已提交：${attributes.title}（${attributes.periodKey}）`);
  console.log(
    `  审核人：${reviewerNames.length > 0 ? reviewerNames.join("、") : "（还没定——需要你指定一次）"}`,
  );
  console.log(
    `  规则来源：${rule}${attributes.validation === "skeleton-only" ? "（未按模板校验，仅骨架）" : ""}`,
  );
  console.log(`  编号：${payload.data?.id ?? "-"}`);
  // 暂存箱收尾：报出去了就从"待办"里消失（找不到那条只提示一句，不影响提交本身的结果）
  if (draftId) {
    const batch = await runDrafts(["submit", draftId, "--item", payload.data?.id ?? ""]);
    if (batch.ok) console.log(`  暂存箱：已标记报出 #${draftId}`);
    else console.log(`  暂存箱：没标记上（${batch.message}）——不影响这次提交`);
  }
  return 0;
}

process.exit(await main(process.argv.slice(2)));
