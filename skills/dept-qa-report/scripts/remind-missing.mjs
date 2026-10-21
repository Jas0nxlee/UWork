#!/usr/bin/env node
/**
 * **催办（业务侧）**：查本部门本周期谁还没交，挨个发一条提醒。
 *
 * 为什么在 skill 里而不是在 IM 服务里（2026-10-19 用户口径）：*"定时任务直接在 uwork 做就行吧，
 * msgbus 只是通信渠道"*。谁该交、算不算交、催什么话——这些是业务；发消息才是渠道的事。
 * 所以这里只用**标准会话 API**（建 DM + 发消息），IM 服务不需要为催办知道任何业务概念。
 *
 * 定时由 UWork 自己的「定时任务」(automation) 负责：到点把一段 prompt 派给 agent，
 * agent 跑这个脚本（见 SKILL.md §五之四）。
 *
 * 用法：
 *   node remind-missing.mjs [--department <部门>] [--period YYYY-MM] [--dry-run] [--only <userId>] [--force]
 *
 * - 缺省部门＝`rollup-scope` 给的可汇总部门；缺省周期＝当月。
 * - `--only` 只催指定的人（**真机验证时用它，避免打扰真实同事**）。
 * - `--force` 重发：忽略"本周期已经催过"的判断。
 * - 幂等**不靠额外的表**：发之前查一次那个人的 DM 里有没有本周期那条提醒（渠道里有事实，就别再造一份）。
 *
 * 退出码：0 成功（含"没人需要催"）；1 拉取/发送失败；2 用法或凭据问题（例如你不是负责人）。
 */
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const only = arg("only");

const baseUrl = process.env.UWORK_WORK_ITEM_BASE_URL?.replace(/\/$/, "");
const token = process.env.UWORK_WORK_ITEM_TOKEN;
if (!baseUrl || !token) {
  console.error("✗ 宿主还没把凭据接进来（UWORK_WORK_ITEM_BASE_URL / UWORK_WORK_ITEM_TOKEN）");
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}` };
const json = (path, init = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers } });

const currentPeriod = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

// ① 我是谁、能汇总哪些部门（拿不到就别猜——猜错的代价是把"拉不到"说成"没有"）
const scopeResponse = await json("/api/work-items/scope");
if (!scopeResponse.ok) {
  console.error(`✗ 读不到汇总范围：${scopeResponse.status}`);
  process.exit(1);
}
const scope = (await scopeResponse.json()).data;
const department = arg("department") ?? scope.canRollup[0];
const period = arg("period") ?? currentPeriod();
if (!department) {
  console.error("✗ 你不能按部门汇总（只有该部门负责人或平台管理员可以），所以也催不了这个部门");
  process.exit(2);
}
if (!scope.canRollup.includes(department)) {
  console.error(`✗ 你不是「${department}」的负责人，不能催这个部门的人`);
  process.exit(2);
}

// ② 该交的人（目录里该部门的成员，去掉负责人自己）
const directory = (await (await json("/api/directory/users?q=")).json()).users ?? [];
const members = directory.filter((user) => (user.department ?? "") === department);
const expected = members.filter((user) => !user.isDepartmentHead);

// ③ 算不算交：该部门 + 该周期里有记录
const listed = await (
  await json(
    `/api/work-items?filter%5Bdepartment%5D=${encodeURIComponent(department)}&filter%5Bperiod%5D=${period}&page%5Bsize%5D=200`,
  )
).json();
const submitted = new Set((listed.data ?? []).map((item) => item.attributes.authorId));
let missing = expected.filter((user) => !submitted.has(user.id));
if (only) missing = missing.filter((user) => user.id === only);

console.log(
  `范围：${department} · ${period} —— 应报 ${expected.length} 人，已交 ${submitted.size} 人，` +
    `未交 ${missing.length} 人${only ? "（本次只处理指定的人）" : ""}`,
);
if (missing.length === 0) {
  console.log("✓ 没有需要催的人");
  process.exit(0);
}

const marker = `【自动提醒】${period}`;
const body = (name) =>
  `${marker}\n${name}，${department} ${period} 的工作记录还没交。\n` +
  `在 UWork 里对 agent 说「把这个月的工作整理成记录」，确认后提交即可。\n` +
  `（这条是系统的定时催办，不是负责人手打的。）`;

let reminded = 0;
let skipped = 0;
for (const user of missing) {
  if (dryRun) {
    console.log(`  · 会催：${user.name}`);
    continue;
  }
  // 建/取与这个人的 DM（服务端幂等）
  const conversation = await (
    await json("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "dm", memberIds: [user.id] }),
    })
  ).json();
  const conversationId = conversation.conversation?.id;
  if (!conversationId) {
    console.error(`  ✗ ${user.name}：建会话失败`);
    continue;
  }
  // 幂等：这个 DM 里已经有本周期的提醒就不再发（事实在渠道里，不另造表）
  if (!force) {
    const found = await (
      await json(
        `/api/conversations/${conversationId}/messages/search?q=${encodeURIComponent(marker)}&limit=1`,
      )
    ).json();
    if ((found.messages ?? []).length > 0) {
      console.log(`  · 跳过：${user.name}（本周期已催过）`);
      skipped += 1;
      continue;
    }
  }
  const sent = await json(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body: body(user.name),
      clientMsgId: `remind-${period}-${user.id}`,
    }),
  });
  if (!sent.ok) {
    console.error(`  ✗ ${user.name}：发送失败 ${sent.status}`);
    continue;
  }
  reminded += 1;
  console.log(`  ✓ 已催：${user.name}`);
}
console.log(
  dryRun
    ? `（--dry-run：没有发任何消息）需催 ${missing.length} 人`
    : `✓ 本次催了 ${reminded} 人，跳过 ${skipped} 人`,
);
