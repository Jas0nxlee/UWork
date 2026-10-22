// @vitest-environment node
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 平台通用件「本地暂存箱」（`skills/_platform/drafts.mjs`）。
 *
 * 用户口径（2026-10-19）：*"这个 skill 应该能够去获取它暂存的这个……有没有一些通用的方式"*——
 * 草稿以前各 skill 自己找地方放，卡片上的「暂存」又只能在本机记一笔（沙箱写不了文件），
 * 于是"我上周暂存的那份呢"没人能回答。这个件就是答案：**暂存＝文件已在箱里，agent 随时列得出来**。
 *
 * 这里钉四件事：① 写入只在自己根目录内（穿越路径/非法编号直接拒）；② 三态状态机可查；
 * ③ 输出是人话（agent 要照读，不能甩 JSON）；④ 提交成功后箱里那条标成"已报出"，失败则保持待办。
 */
const REPO_ROOT = join(import.meta.dirname, "../../..");
const DRAFTS = join(REPO_ROOT, "skills/_platform/drafts.mjs");
const SUBMIT = join(REPO_ROOT, "skills/dept-qa-report/scripts/submit-work-item.mjs");
const DRAFT_FIXTURE = join(REPO_ROOT, "skills/dept-qa-report/example.card.json");

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

/** 跑一次 CLI，返回退出码与合并输出（这些脚本的"失败"也走退出码，不能让它抛）。 */
function run(file: string, args: string[], env: Record<string, string>) {
  try {
    const stdout = execFileSync(process.execPath, [file, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** 异步版：跑提交脚本时**必须**用它——同步版会堵住宿主事件循环，假 msgbus 就答不了、双方死等。 */
function runAsync(file: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [file, ...args],
      { env: { ...process.env, ...env }, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failure = error as { code?: number } | null;
        resolve({
          code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
          out: `${stdout ?? ""}${stderr ?? ""}`,
        });
      },
    );
  });
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "drafts-"));
}

function stageOne(root: string, title = "第 43 周配置项测试记录") {
  const payload = join(root, "payload-in.json");
  writeFileSync(payload, readFileSync(DRAFT_FIXTURE));
  const staged = run(
    DRAFTS,
    ["stage", "--kind", "dept-qa-report.draft", "--title", title, "--payload", payload],
    { UWORK_DRAFTS_DIR: root },
  );
  expect(staged.code).toBe(0);
  const id = /#([0-9]{8}-[0-9]{6}-[a-z0-9-]+)/.exec(staged.out)?.[1] ?? "";
  return { id, out: staged.out };
}

describe("本地暂存箱", () => {
  it("stage：写进自己根目录、业务内容一起搬进去，输出是人话（带编号与位置）", () => {
    const root = freshRoot();
    const { id, out } = stageOne(root);
    expect(id).toMatch(/^[0-9]{8}-[0-9]{6}-draft$/);
    expect(out).toContain("✓ 已暂存");
    expect(out).toContain(root);
    const dir = join(root, id);
    expect(existsSync(join(dir, "draft.json"))).toBe(true);
    expect(existsSync(join(dir, "payload.json"))).toBe(true);
    const envelope = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(envelope.status).toBe("staged");
    expect(envelope.kind).toBe("dept-qa-report.draft");
    expect(envelope.submission).toBeNull();
  });

  it("list 默认只列还没报出去的，输出带编号/时间/状态/标题（agent 直接照读）", () => {
    const root = freshRoot();
    const { id } = stageOne(root);
    const listed = run(DRAFTS, ["list"], { UWORK_DRAFTS_DIR: root });
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(id);
    expect(listed.out).toContain("[staged]");
    expect(listed.out).toContain("第 43 周配置项测试记录");
    expect(listed.out).not.toContain("{");
  });

  it("submit / drop：三态流转，报出去之后就不再出现在待办列表里", () => {
    const root = freshRoot();
    const { id } = stageOne(root);
    const submitted = run(DRAFTS, ["submit", id, "--item", "work-item-1"], {
      UWORK_DRAFTS_DIR: root,
    });
    expect(submitted.code).toBe(0);
    expect(submitted.out).toContain("已标记报出");
    expect(run(DRAFTS, ["list"], { UWORK_DRAFTS_DIR: root }).out).toContain("没有还没报出去的草稿");
    const show = run(DRAFTS, ["show", id], { UWORK_DRAFTS_DIR: root });
    expect(show.out).toContain("submitted");
    expect(show.out).toContain("work-item-1");

    const other = stageOne(root, "另一份").id;
    expect(
      run(DRAFTS, ["drop", other, "--reason", "写错了"], { UWORK_DRAFTS_DIR: root }).code,
    ).toBe(0);
    expect(run(DRAFTS, ["show", other], { UWORK_DRAFTS_DIR: root }).out).toContain("dropped");
  });

  it("prune 只清 dropped（没报出去的与报过的记录都不能被悄悄删掉）", () => {
    const root = freshRoot();
    const { id: kept } = stageOne(root, "留着的");
    const dropped = stageOne(root, "要丢的").id;
    run(DRAFTS, ["drop", dropped, "--reason", "重复"], { UWORK_DRAFTS_DIR: root });
    const pruned = run(DRAFTS, ["prune"], { UWORK_DRAFTS_DIR: root });
    expect(pruned.out).toContain("清掉 1 条");
    expect(existsSync(join(root, dropped))).toBe(false);
    expect(existsSync(join(root, kept))).toBe(true);
  });

  it("只写自己根目录之内：非法编号与穿越路径都拒（退出码 2）", () => {
    const root = freshRoot();
    for (const bad of [
      ["show", "../escape"],
      ["show", "/etc/passwd"],
      ["stage", "--kind", "../../etc", "--title", "x"],
      ["stage", "--kind", "ok.kind", "--title", "   "],
    ]) {
      const result = run(DRAFTS, bad, { UWORK_DRAFTS_DIR: root });
      expect(result.code).toBe(2);
      expect(result.out).toContain("✗");
    }
  });
});

/** 假 msgbus：提交成功 / 被拒两种结果，用来验"暂存箱只在成功后收尾"。 */
async function stubMsgbus(status: number): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/directory/users")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ users: [] }));
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      status === 201
        ? JSON.stringify({
            data: {
              id: "wi-1",
              attributes: {
                title: "第 43 周配置项测试记录",
                periodKey: "2026-10",
                validation: "template",
              },
            },
            meta: { resolvedReviewers: [], resolvedBy: "record" },
          })
        : JSON.stringify({ errors: [{ status: String(status), detail: "forbidden" }] }),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("提交脚本与暂存箱的联动", () => {
  it("提交成功 → 箱里那条标成已报出（带业务编号）", async () => {
    const root = freshRoot();
    const { id } = stageOne(root);
    const baseUrl = await stubMsgbus(201);
    const submitted = await runAsync(
      SUBMIT,
      ["--draft", join(root, id, "payload.json"), "--draft-id", id],
      {
        UWORK_DRAFTS_DIR: root,
        UWORK_WORK_ITEM_BASE_URL: baseUrl,
        UWORK_WORK_ITEM_TOKEN: "stub",
      },
    );
    expect(submitted.code).toBe(0);
    expect(submitted.out).toContain("已提交");
    expect(submitted.out).toContain(`已标记报出 #${id}`);
    const envelope = JSON.parse(readFileSync(join(root, id, "draft.json"), "utf8")) as {
      status: string;
      submission: { item: string };
    };
    expect(envelope.status).toBe("submitted");
    expect(envelope.submission.item).toBe("wi-1");
  });

  it("服务端拒绝 → 提交失败、箱里的草稿仍留在待办（不能假装报过了）", async () => {
    const root = freshRoot();
    const { id } = stageOne(root);
    const baseUrl = await stubMsgbus(403);
    const rejected = await runAsync(
      SUBMIT,
      ["--draft", join(root, id, "payload.json"), "--draft-id", id],
      {
        UWORK_DRAFTS_DIR: root,
        UWORK_WORK_ITEM_BASE_URL: baseUrl,
        UWORK_WORK_ITEM_TOKEN: "stub",
      },
    );
    expect(rejected.code).not.toBe(0);
    expect(rejected.out).not.toContain("已标记报出");
    const envelope = JSON.parse(readFileSync(join(root, id, "draft.json"), "utf8")) as {
      status: string;
    };
    expect(envelope.status).toBe("staged");
  });
});
