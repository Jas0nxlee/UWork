// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * agent 端汇报卡片的**动作**（`汇报` / `暂存` 两个按钮）。
 *
 * 卡片是沙箱里的 HTML，按钮能动的唯一通路是 follow-up（`window.zcode.sendFollowUpMessage`），
 * 宿主还会校验用户手势——所以"按钮自己触发 agent"在结构上不可能。这里把三件事钉住：
 * ① 脚本生成出来的按钮带对了提示词；② 点了真的调 follow-up；③ 环境不支持 / 调用失败时**说人话**，
 * 而不是静默什么都不发生（这正是上一轮 IM 卡片踩过的坑）。
 */
const REPO_ROOT = join(import.meta.dirname, "../../..");
const RENDER = join(REPO_ROOT, "skills/dept-qa-report/scripts/render-card.mjs");
const DRAFT = join(REPO_ROOT, "skills/dept-qa-report/example.card.json");

function renderCard(): string {
  const out = mkdtempSync(join(tmpdir(), "card-actions-"));
  const stdout = execFileSync(
    process.execPath,
    [RENDER, "--draft", DRAFT, "--out", join(out, "card-test.html")],
    { env: { ...process.env, ZCODE_GEN_UI_OUTPUT_ROOT: out }, encoding: "utf8" },
  );
  const path = stdout.split("\n")[0]!.trim();
  return readFileSync(path, "utf8");
}

/** 把卡片片段装进 document，并执行它的内联脚本（jsdom 默认不跑页内脚本）。 */
function mount(html: string, zcode?: unknown): void {
  document.body.innerHTML = html;
  const script = document.querySelector("script")?.textContent ?? "";
  (globalThis as unknown as { zcode?: unknown }).zcode = zcode;
  (window as unknown as { zcode?: unknown }).zcode = zcode;
  // eslint-disable-next-line no-new-func
  new Function(script)();
}

/** 期望值一律从草稿里读（`example.card.json` 是模板自带的示例，改它不该弄红测试）。 */
const draftTitle = (JSON.parse(readFileSync(DRAFT, "utf8")) as { title: string }).title;
const buttons = () => [...document.querySelectorAll("button[data-prompt], button[data-local]")];
const buttonByLabel = (label: string): HTMLButtonElement => {
  const found = buttons().find((button) => button.textContent === label);
  if (!found) throw new Error(`没有「${label}」按钮`);
  return found as HTMLButtonElement;
};
const status = (): string => document.querySelector("[data-card-status]")?.textContent ?? "";

describe("agent 汇报卡片的动作按钮", () => {
  it("卡片结构：「汇报」带提示词（生成期就写死），「暂存」是本地按钮、不带提示词", () => {
    const html = renderCard();
    expect(html).toContain(`data-prompt="汇报：${draftTitle}"`);
    expect(html).toContain('data-local="stage"');
    // 关键：暂存**没有** data-prompt——它不走 follow-up，不进会话，不叫 agent
    expect(html).not.toContain('data-prompt="暂存');
    // 草稿路径写进卡片：这样"暂存"才说得清是"留着这个文件"
    expect(html).toContain("草稿在本机");
    mount(html);
    expect(buttons().map((button) => button.textContent)).toEqual(["汇报", "暂存"]);
    expect(buttonByLabel("汇报").getAttribute("data-prompt")).toBe(`汇报：${draftTitle}`);
  });

  it("点「汇报」→ 调 follow-up，提示词与标题都对，并给出进行中/已发送的状态", async () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    mount(renderCard(), { sendFollowUpMessage });
    const report = buttonByLabel("汇报");
    report.click();
    // 点击后立刻进入"进行中"（两颗按钮都禁用，避免连点发两次）
    expect(status()).toContain("正在");
    expect(buttons().every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    await vi.waitFor(() => expect(sendFollowUpMessage).toHaveBeenCalledTimes(1));
    const input = sendFollowUpMessage.mock.calls[0]![0] as { prompt: string; title: string };
    expect(input.prompt).toMatch(/^汇报：/);
    expect(input.title).toBe(draftTitle);
    await vi.waitFor(() => expect(status()).toContain("已交给 agent"));
    expect(buttons().every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("点「暂存」→ **什么都不发**，只在本机 privateContent 里记一笔（用户的原始要求）", async () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    const setWidgetState = vi.fn().mockResolvedValue(undefined);
    mount(renderCard(), {
      sendFollowUpMessage,
      setWidgetState,
      widgetState: { modelContent: null, privateContent: null },
    });
    buttonByLabel("暂存").click();
    await vi.waitFor(() => expect(setWidgetState).toHaveBeenCalledTimes(1));
    // ① 一条消息都不发：不叫 agent、不打模型、不进会话
    expect(sendFollowUpMessage).not.toHaveBeenCalled();
    // ② 只写 privateContent——写进 modelContent 会随上下文带给模型，那就不是"只留本地"了
    const next = setWidgetState.mock.calls[0]![0] as {
      modelContent: unknown;
      privateContent: { stagedAt?: string };
    };
    expect(next.modelContent).toBeNull();
    expect(typeof next.privateContent.stagedAt).toBe("string");
    await vi.waitFor(() => expect(status()).toContain("未上传"));
  });

  it("暂存过的卡片重新渲染时读本机状态，显示「已暂存（本机）」", () => {
    const html = renderCard();
    mount(html, {
      widgetState: { modelContent: null, privateContent: { stagedAt: "2026-10-19T08:30:00.000Z" } },
    });
    expect(status()).toContain("已暂存（本机）");
  });

  it("本地状态读不到时不影响按钮（坏状态不该把卡片弄瘫）", () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    mount(renderCard(), {
      sendFollowUpMessage,
      get widgetState() {
        throw new Error("state unavailable");
      },
    });
    expect(status()).not.toContain("已暂存");
    buttonByLabel("汇报").click();
    expect(sendFollowUpMessage).toHaveBeenCalledTimes(1);
  });

  it("沙箱外（没有 window.zcode）不静默失败：汇报提示直接回一句话，暂存说明草稿本来就在本机", () => {
    mount(renderCard(), undefined);
    buttonByLabel("汇报").click();
    expect(status()).toContain("直接回一句");
    expect(status()).toContain("汇报：");
    buttonByLabel("暂存").click();
    expect(status()).toContain("草稿本来就在本机");
  });

  it("follow-up 被拒/失败时显示原因，且按钮恢复可点（用户能重试）", async () => {
    const sendFollowUpMessage = vi.fn().mockRejectedValue(new Error("Follow-up cancelled"));
    mount(renderCard(), { sendFollowUpMessage });
    buttonByLabel("汇报").click();
    await vi.waitFor(() => expect(status()).toContain("没成功"));
    expect(status()).toContain("Follow-up cancelled");
    expect(buttons().every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });
});
