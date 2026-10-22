#!/usr/bin/env node
/**
 * **我能汇总什么**：把"你是谁、能按哪些部门拉台账"用一句人话问出来。
 *
 * 为什么要单独一步：部门台账只有该部门负责人（或平台管理员）拉得动（服务端 403），
 * 而 agent 面对一个人时并不知道他是谁。**猜的代价是假消息**——"拉不到"被说成"这个月没有记录"。
 * 所以顺序固定：先 `rollup-scope` → 再按 `canRollup` 拉；`canRollup` 为空就如实说"你没这个权限"。
 *
 * 用法：node skills/dept-qa-report/scripts/rollup-scope.mjs
 * 凭据由宿主注入（UWORK_WORK_ITEM_BASE_URL / UWORK_WORK_ITEM_TOKEN），不要手传令牌。
 * 退出码：0 有把握（含"只能看与我相关的"这种结论）；1 拉不到 scope；2 用法/凭据问题。
 */
const baseUrl = process.env.UWORK_WORK_ITEM_BASE_URL?.replace(/\/$/, "");
const token = process.env.UWORK_WORK_ITEM_TOKEN;
if (!baseUrl || !token) {
  console.error("✗ 宿主还没把工作项凭据接进来（UWORK_WORK_ITEM_BASE_URL / UWORK_WORK_ITEM_TOKEN）");
  process.exit(2);
}

const response = await fetch(`${baseUrl}/api/work-items/scope`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!response.ok) {
  console.error(`✗ 读取汇总范围失败：${response.status}`);
  process.exit(1);
}
const { data } = await response.json();
const mine =
  Array.isArray(data.department) && data.department.length > 0
    ? data.department.join("、")
    : "（白名单里查不到）";
const identity = data.isOrgAdmin ? "平台管理员" : data.isDepartmentHead ? "部门负责人" : "普通成员";

console.log(`你：${mine}（${identity}）`);
if (data.canRollup.length > 0) {
  console.log(`能按部门汇总：${data.canRollup.join("、")}`);
  console.log(
    `用法：node skills/dept-qa-report/scripts/export-ledger.mjs --department <部门> [--period YYYY-MM]`,
  );
  if (!data.canRollup.includes(mine)) {
    console.log(`（你自己的部门「${mine}」不在可汇总范围里——别把别人的部门当成自己的）`);
  }
} else {
  console.log("不能按部门汇总：只有「与我相关」的记录能看（我发的 + 发给我的）。");
  console.log("要汇总整个部门，需要该部门负责人来做（或让管理员把部门加进白名单）。");
}
