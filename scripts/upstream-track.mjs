#!/usr/bin/env node
/* eslint-disable max-lines -- 追踪器要同时管「开源快照轨」与「官方发布轨」两条口径、两套 ref 解析和报告输出，集中在一个文件里才能保证分类口径不漂移。 */
/**
 * 上游 ZCode 版本追踪。
 *
 * 上游 zai-org/ZCode 是「整树快照」式发布：每次一个 commit 覆盖全仓，
 * 所以「文件不同」不等于「谁更新」，只能判断谁动过。本脚本只做哈希级比对，
 * 不读 blob 内容，因而在 partial clone（--filter=blob:none）上也能秒级完成。
 *
 * 两条轨道都要看（2026-10-13 实测：官方 stable 3.15.3，开源快照还停在 v3.15.1）：
 *   1. 开源快照轨 —— zai-org/ZCode 的整树 commit/tag，决定我们合并的代码基线；
 *   2. 官方发布轨 —— zcode.z.ai 的 Electron 更新 manifest，用户实际拿到的版本。
 *
 * 用法：
 *   node scripts/upstream-track.mjs status [--fetch]
 *   node scripts/upstream-track.mjs diff [--fetch] [--base <ref>] [--upstream <ref>] [--ours <ref>]
 *
 * 常用参数：
 *   --fetch              抓上游（只读网络操作）：分支进 refs/remotes/<remote>/，
 *                       上游 tag 进 refs/upstream-tags/——**不能**用 `git fetch --tags`，
 *                       UWork 自有发版 tag 与上游同名（v3.15.1 等），会互相覆盖
 *   --remote <name>      上游 remote 名（默认 zcode，回退 upstream）
 *   --ours <ref>         我方 ref（默认 HEAD）
 *   --tracking <ref>     追踪分支 ref（status 用，默认 origin/main）
 *   --base <ref>         上一快照 ref（diff 用，默认上游历史里的上一个 tag）
 *   --upstream <ref>     上游 ref（默认上游最新快照 tag，回退远端默认分支）
 *   --platform <p>       官方 manifest 的平台参数（默认 darwin-aarch64）
 *   --endpoint <url>     官方 manifest 端点（默认 https://zcode.z.ai）
 *   --no-official        跳过官方发布轨查询（纯离线）
 *   --source-only        只输出源码类路径
 *   --json <path>        额外写出机器可读结果
 *   --conflicts <path>   把真冲突面（双方都改）逐行写入文件
 *   --limit <n>          终端最多打印多少条路径（默认 40）
 *
 * status 退出码：0 = 我方已含最新开源快照、且快照不低于官方 stable；2 = 任一轨落后；1 = 用法/环境错误。
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".sh",
]);

const GENERATED_PATHS = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)THIRD-PARTY-NOTICES\.md$/,
  /(^|\/)third-party\/inventory\.json$/,
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function tryGit(args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

function isGitRepo() {
  return tryGit(["rev-parse", "--is-inside-work-tree"]) === "true";
}

function resolveRemote(preferred) {
  const remotes = (tryGit(["remote"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (preferred && remotes.includes(preferred)) return preferred;
  for (const candidate of [preferred, "zcode", "upstream"]) {
    if (candidate && remotes.includes(candidate)) return candidate;
  }
  throw new Error(`找不到上游 remote（现有：${remotes.join(", ") || "无"}）`);
}

const UPSTREAM_TAG_NAMESPACE = "refs/upstream-tags";

/**
 * 抓上游。上游 tag 落到独立 namespace：UWork 自有发版 tag 与上游同名
 * （v3.14.3…v3.15.x 两边都有），直接 `git fetch --tags` 会互相覆盖。
 */
function fetchUpstream(remote) {
  console.log(
    `git fetch ${remote}（分支 → refs/remotes/${remote}/，tag → ${UPSTREAM_TAG_NAMESPACE}/）…`,
  );
  git([
    "fetch",
    remote,
    "--force",
    `+refs/heads/*:refs/remotes/${remote}/*`,
    `+refs/tags/*:${UPSTREAM_TAG_NAMESPACE}/*`,
  ]);
}

function upstreamDefaultBranch(remote) {
  const symbolic = tryGit(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (symbolic) return symbolic;
  for (const candidate of ["main", "master"]) {
    if (
      tryGit(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`]) !== null
    ) {
      return `${remote}/${candidate}`;
    }
  }
  return null;
}

function requireUpstreamRef(remote) {
  const ref = upstreamDefaultBranch(remote);
  if (!ref) {
    throw new Error(
      `拿不到 ${remote} 的默认分支，先跑：node scripts/upstream-track.mjs status --fetch`,
    );
  }
  return ref;
}

function isSourcePath(path) {
  if (GENERATED_PATHS.some((pattern) => pattern.test(path))) return false;
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * 上游快照 = refs/upstream-tags/ 下的 semver tag，且能到达上游默认分支。
 * 上游是「整树快照」式发布，一个 tag 一次覆盖全仓。
 * 必须保留完整的 namespaced ref：裸名 v3.15.1 会被本地同名 tag（UWork 自有发版）抢走。
 */
function upstreamSnapshots(upstreamRef) {
  const rows = (
    tryGit([
      "for-each-ref",
      "--format=%(refname)\t%(objectname)\t%(*objectname)",
      UPSTREAM_TAG_NAMESPACE,
    ]) ?? ""
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, objectName, peeled] = line.split("\t");
      return {
        name: ref.slice(`${UPSTREAM_TAG_NAMESPACE}/`.length),
        ref,
        commit: peeled || objectName,
      };
    })
    .filter((row) => /^v\d+\.\d+\.\d+$/.test(row.name))
    .filter((row) => tryGit(["merge-base", "--is-ancestor", row.commit, upstreamRef]) !== null)
    .sort((a, b) => compareVersions(b.name, a.name));
  return rows;
}

/** 上游默认分支上、比最新 tag 更新的提交（可能已发布但未打 tag）。 */
function untaggedSnapshots(upstreamRef, latestTagCommit) {
  if (!latestTagCommit) return [];
  return (tryGit(["log", "--format=%h\t%cs\t%s", `${latestTagCommit}..${upstreamRef}`]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [short, date, subject] = line.split("\t");
      return { short, date, subject };
    });
}

/**
 * 官方发布轨：zcode.z.ai 的 Electron 更新 manifest。
 * 官方发版（3.15.2、3.15.3…）常常领先于公开发布的整树快照，两条轨道都要看。
 */
const OFFICIAL_MANIFEST_PATH = "/api/v1/releases/electron/manifest";

async function fetchOfficialRelease(endpointOrigin, platform, channel) {
  const url = new URL(OFFICIAL_MANIFEST_PATH, `${endpointOrigin.replace(/\/+$/, "")}/`);
  url.searchParams.set("platform", platform);
  url.searchParams.set("channel", channel === "preview" ? "3" : "1");
  const response = await fetch(url, {
    headers: { Accept: "application/x-yaml,text/yaml,text/plain,*/*" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  return {
    channel,
    version: /^version:\s*(\S+)/m.exec(text)?.[1] ?? null,
    releaseName: /^releaseName:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null,
    url: url.toString(),
  };
}

async function readOfficialReleases(endpointOrigin, platform) {
  const results = await Promise.allSettled([
    fetchOfficialRelease(endpointOrigin, platform, "stable"),
    fetchOfficialRelease(endpointOrigin, platform, "preview"),
  ]);
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : {
          channel: index === 0 ? "stable" : "preview",
          version: null,
          error: String(result.reason?.message ?? result.reason),
        },
  );
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function refInfo(ref) {
  const line = tryGit(["log", "-1", "--format=%H\t%cs\t%s", ref]);
  if (!line) return null;
  const [commit, date, subject] = line.split("\t");
  return { ref, commit, short: commit.slice(0, 8), date, subject };
}

/** 读某个 ref 的 package.json 版本号，不检出工作区（partial clone 只取该 blob）。 */
function packageVersion(ref, path) {
  const raw = tryGit(["show", `${ref}:${path}`]);
  if (!raw) return null;
  try {
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

/** 索引级文件清单：`git ls-tree -r` 只给 mode/type/hash/path，不会懒加载 blob。 */
function treeEntries(ref) {
  const out = git(["ls-tree", "-r", ref]);
  const entries = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, hash] = line.slice(0, tab).split(/\s+/);
    const path = line.slice(tab + 1);
    entries.set(path, `${mode}:${type}:${hash}`);
  }
  return entries;
}

function containsRef(ancestor, descendant) {
  return tryGit(["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
}

function classify(base, upstream, ours) {
  const buckets = {
    identical: [],
    upstreamChanged: [],
    upstreamAdded: [],
    bothChanged: [],
    oursChanged: [],
    oursOnly: [],
    upstreamOnly: [],
    upstreamDeletedWeKeep: [],
  };
  const paths = new Set([...base.keys(), ...upstream.keys(), ...ours.keys()]);
  for (const path of paths) {
    const inBase = base.get(path);
    const inUpstream = upstream.get(path);
    const inOurs = ours.get(path);
    const upstreamMoved = inUpstream !== inBase;
    const oursMoved = inOurs !== inBase;
    if (!upstreamMoved && !oursMoved) {
      // 含「上游删、我方也删」：双方结论一致，无动作。
      buckets.identical.push(path);
    } else if (!inBase && inUpstream && inOurs && inUpstream === inOurs) {
      // 双方各自新增同一份内容：无冲突。
      buckets.identical.push(path);
    } else if (!inBase && !inOurs && inUpstream) {
      buckets.upstreamAdded.push(path);
    } else if (!inBase && !inUpstream && inOurs) {
      buckets.oursOnly.push(path);
    } else if (!inBase && inUpstream && inOurs) {
      buckets.bothChanged.push(path);
    } else if (!inUpstream && inOurs) {
      buckets.upstreamDeletedWeKeep.push(path);
    } else if (inUpstream && !inOurs) {
      buckets.upstreamOnly.push(path);
    } else if (upstreamMoved && oursMoved && inUpstream !== inOurs) {
      buckets.bothChanged.push(path);
    } else if (upstreamMoved && inUpstream !== inOurs) {
      buckets.upstreamChanged.push(path);
    } else {
      buckets.oursChanged.push(path);
    }
  }
  return buckets;
}

/** 内容完全相同的「增删对」= 整树快照下的改名候选。 */
function renameCandidates(base, upstream) {
  const byHash = new Map();
  for (const [path, value] of upstream) {
    const hash = value.split(":")[2];
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(path);
  }
  const pairs = [];
  for (const [path, value] of base) {
    if (upstream.has(path)) continue;
    const hash = value.split(":")[2];
    for (const candidate of byHash.get(hash) ?? []) {
      if (!base.has(candidate)) pairs.push([path, candidate]);
    }
  }
  return pairs;
}

function formatCount(paths) {
  return `${paths.length}/${paths.filter(isSourcePath).length}`;
}

/** 中日韩字符按两列宽计算，否则终端表格对不齐。 */
function displayWidth(text) {
  let width = 0;
  for (const char of text) width += /[\u2E80-\uFFFD]/.test(char) ? 2 : 1;
  return width;
}

function padDisplay(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

/** 打印用短名：上游 tag 在 refs/upstream-tags/ 命名空间里，裸名更可读。 */
function snapshotLabel(ref, snapshots) {
  return snapshots.find((row) => row.ref === ref)?.name ?? ref;
}

/** 分类的中文名，status 与 diff 共用，避免两处口径漂移。 */
const BUCKET_LABELS = [
  ["一致", "identical"],
  ["上游单方改", "upstreamChanged"],
  ["上游新增", "upstreamAdded"],
  ["双方都改", "bothChanged"],
  ["我方单方改", "oursChanged"],
  ["我方独有", "oursOnly"],
  ["上游有我方无", "upstreamOnly"],
  ["上游删我方留", "upstreamDeletedWeKeep"],
];

function bucketCounts(buckets) {
  return Object.fromEntries(
    Object.entries(buckets).map(([key, paths]) => [
      key,
      { all: paths.length, source: paths.filter(isSourcePath).length },
    ]),
  );
}

function bucketPayload(buckets, sourceOnly) {
  return Object.fromEntries(
    Object.entries(buckets).map(([key, paths]) => [
      key,
      sourceOnly ? paths.filter(isSourcePath) : paths,
    ]),
  );
}

function writeJson(path, payload) {
  writeFileSync(resolve(path), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nJSON 已写入 ${resolve(path)}`);
}

function assertRef(ref, label) {
  if (tryGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null) {
    throw new Error(
      `${label} ref 不存在：${ref}（先跑：node scripts/upstream-track.mjs <status|diff> --fetch）`,
    );
  }
}

function parseArgs(argv) {
  const args = { command: "status", limit: 40 };
  const rest = [...argv];
  args.command = rest.shift() ?? "status";
  if (!["status", "diff"].includes(args.command)) {
    throw new Error(`未知子命令：${args.command}（可用：status、diff）`);
  }
  while (rest.length) {
    const flag = rest.shift();
    switch (flag) {
      case "--fetch":
        args.fetch = true;
        break;
      case "--remote":
        args.remote = rest.shift();
        break;
      case "--ours":
        args.ours = rest.shift();
        break;
      case "--base":
        args.base = rest.shift();
        break;
      case "--upstream":
        args.upstream = rest.shift();
        break;
      case "--json":
        args.json = rest.shift();
        break;
      case "--conflicts":
        args.conflicts = rest.shift();
        break;
      case "--limit":
        args.limit = Number(rest.shift() ?? 40);
        break;
      case "--source-only":
        args.sourceOnly = true;
        break;
      case "--platform":
        args.platform = rest.shift();
        break;
      case "--endpoint":
        args.endpoint = rest.shift();
        break;
      case "--no-official":
        args.noOfficial = true;
        break;
      case "--tracking":
        args.tracking = rest.shift();
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }
  return args;
}

function printList(title, paths, limit) {
  if (!paths.length) return;
  console.log(`\n${title}（${paths.length}）`);
  for (const path of paths.slice(0, limit)) console.log(`  ${path}`);
  if (paths.length > limit)
    console.log(`  … 其余 ${paths.length - limit} 条见 --json / --conflicts 输出`);
}

const DEFAULT_OFFICIAL_ENDPOINT = "https://zcode.z.ai";

async function statusReport(args) {
  const remote = resolveRemote(args.remote);
  if (args.fetch) fetchUpstream(remote);
  const official = args.noOfficial
    ? []
    : await readOfficialReleases(
        args.endpoint ?? DEFAULT_OFFICIAL_ENDPOINT,
        args.platform ?? "darwin-aarch64",
      );
  const upstreamDefault = requireUpstreamRef(remote);
  const snapshots = upstreamSnapshots(upstreamDefault);
  const latestRow = snapshots[0];
  const latest = args.upstream ?? latestRow?.ref ?? upstreamDefault;
  if (tryGit(["rev-parse", "--verify", "--quiet", `${latest}^{commit}`]) === null) {
    throw new Error(
      `上游 ref 不存在：${latest}（先跑：node scripts/upstream-track.mjs status --fetch）`,
    );
  }
  const upstreamInfo = refInfo(latest);
  const oursRef = args.ours ?? "HEAD";
  const oursInfo = refInfo(oursRef);
  if (!oursInfo) throw new Error(`我方 ref 不存在：${oursRef}`);

  const upstreamPkg = packageVersion(latest, "package.json");
  const upstreamCli = packageVersion(latest, "apps/zcode-cli/package.json");
  const oursPkg = packageVersion(oursRef, "package.json");
  const oursCli = packageVersion(oursRef, "apps/zcode-cli/package.json");

  const baseRow = snapshots.find((row) => row.commit !== upstreamInfo.commit);
  const base = args.base ?? baseRow?.ref ?? `${latest}~1`;
  const upstreamEntries = treeEntries(latest);
  const oursEntries = treeEntries(oursRef);
  const baseEntries =
    tryGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) !== null
      ? treeEntries(base)
      : new Map();
  const buckets = classify(baseEntries, upstreamEntries, oursEntries);
  const syncsUpstream = containsRef(upstreamInfo.commit, oursInfo.commit);
  const untagged = untaggedSnapshots(upstreamDefault, upstreamInfo.commit);
  const trackingRef = args.tracking ?? "origin/main";
  const trackingInfo = refInfo(trackingRef);
  const trackingUpTo = snapshots.find((row) =>
    containsRef(row.commit, trackingInfo?.commit ?? "HEAD"),
  );

  console.log(`上游 ZCode（remote: ${remote}，默认分支 ${upstreamDefault}）`);
  console.log(
    `  最新快照   ${latestRow?.name ?? latest}  ${upstreamInfo.short}  ${upstreamInfo.date}  ${upstreamInfo.subject}`,
  );
  console.log(
    `             package.json ${upstreamPkg ?? "?"} / apps/zcode-cli ${upstreamCli ?? "?"}`,
  );
  const previous = snapshots.find((row) => row.commit !== upstreamInfo.commit);
  if (previous) {
    const info = refInfo(previous.ref);
    console.log(`  上一快照   ${previous.name}  ${info.short}  ${info.date}  ${info.subject}`);
  }
  if (untagged.length) {
    console.log(
      `  未打 tag   ${untagged.length} 个提交在 ${latest} 之后（上游可能已发新版但未打 tag）`,
    );
    for (const row of untagged.slice(0, 5))
      console.log(`             ${row.short}  ${row.date}  ${row.subject}`);
  }

  const officialStable = official.find((row) => row.channel === "stable")?.version ?? null;
  const officialGap =
    officialStable && upstreamPkg ? compareVersions(`v${officialStable}`, `v${upstreamPkg}`) : null;
  if (official.length) {
    console.log(
      `\n官方发布轨（${args.endpoint ?? DEFAULT_OFFICIAL_ENDPOINT}，platform ${args.platform ?? "darwin-aarch64"}）`,
    );
    for (const row of official) {
      console.log(
        `  ${row.channel.padEnd(8)} ${row.version ?? `查不到（${row.error}）`}${row.releaseName ? `  ${row.releaseName}` : ""}`,
      );
    }
    if (officialGap === null) {
      console.log("  与开源快照轨无法比对（缺版本号）");
    } else if (officialGap > 0) {
      console.log(
        `  ⚠️ 官方 stable 领先开源快照 ${snapshotLabel(latest, snapshots)}（快照 package.json ${upstreamPkg}）——` +
          " 官方发版可能未同步到公开仓库，合并快照后仍有功能缺口",
      );
    } else if (officialGap === 0) {
      console.log("  官方 stable 与开源快照一致");
    } else {
      console.log("  开源快照领先官方 stable（官方可能刚回滚或快照来自 preview 线）");
    }
  }

  console.log(`\n我方位置（${oursRef}）`);
  console.log(`  ${oursInfo.short}  ${oursInfo.date}  ${oursInfo.subject}`);
  console.log(`             package.json ${oursPkg ?? "?"} / apps/zcode-cli ${oursCli ?? "?"}`);
  console.log(`  是否已含最新快照：${syncsUpstream ? "是 ✅" : "否 ❌（落后）"}`);
  if (trackingInfo) {
    console.log(
      `  追踪分支 ${trackingRef}：${trackingInfo.short}  ${trackingInfo.date}  停在 ${
        trackingUpTo ? trackingUpTo.name : "（没有任何上游快照）"
      }`,
    );
  } else {
    console.log(`  追踪分支 ${trackingRef}：本地不存在`);
  }

  console.log(`\n与上游最新快照的文件级比对（base = ${snapshotLabel(base, snapshots)}）`);
  for (const [label, key] of BUCKET_LABELS) {
    const suffix =
      key === "upstreamChanged"
        ? "  （可直拿候选）"
        : key === "bothChanged"
          ? "  （真冲突面）"
          : key === "oursChanged"
            ? "  （定制，保留）"
            : "";
    console.log(`  ${padDisplay(label, 16)}${formatCount(buckets[key])}${suffix}`);
  }
  console.log("  （格式：路径数/源码类路径数；源码类 = 代码扩展名且非生成物）");

  printList(
    "真冲突面（双方都改，合并时必须一起看）",
    buckets.bothChanged.filter(isSourcePath),
    args.limit,
  );
  printList("我方定制（保留）", buckets.oursChanged.filter(isSourcePath), Math.min(args.limit, 20));

  if (args.json) {
    writeJson(args.json, {
      generatedAt: new Date().toISOString(),
      remote,
      upstreamDefaultBranch: upstreamDefault,
      upstream: {
        ref: latest,
        ...upstreamInfo,
        packageVersion: upstreamPkg,
        cliVersion: upstreamCli,
      },
      untaggedSnapshots: untagged,
      officialReleases: official,
      officialGap,
      ours: { ref: oursRef, ...oursInfo, packageVersion: oursPkg, cliVersion: oursCli },
      tracking: trackingInfo
        ? { ref: trackingRef, ...trackingInfo, atSnapshot: trackingUpTo?.name ?? null }
        : null,
      containsUpstream: syncsUpstream,
      base,
      counts: bucketCounts(buckets),
      buckets: bucketPayload(buckets, args.sourceOnly),
    });
  }

  // 退出码：0 = 我方已含最新开源快照、且快照不低于官方 stable；2 = 任一轨落后。
  return !syncsUpstream || (officialGap ?? 0) > 0 ? 2 : 0;
}

function diffReport(args) {
  const remote = resolveRemote(args.remote);
  if (args.fetch) fetchUpstream(remote);
  const upstreamDefault = requireUpstreamRef(remote);
  const snapshots = upstreamSnapshots(upstreamDefault);
  const upstreamRef = args.upstream ?? snapshots[0]?.ref ?? upstreamDefault;
  assertRef(upstreamRef, "上游");
  const upstreamCommit = tryGit(["rev-parse", `${upstreamRef}^{commit}`]);
  const baseRef =
    args.base ?? snapshots.find((row) => row.commit !== upstreamCommit)?.ref ?? `${upstreamRef}~1`;
  const oursRef = args.ours ?? "HEAD";
  assertRef(baseRef, "base");
  assertRef(oursRef, "ours");

  const base = treeEntries(baseRef);
  const upstream = treeEntries(upstreamRef);
  const ours = treeEntries(oursRef);
  const buckets = classify(base, upstream, ours);
  const renames = renameCandidates(base, upstream);
  const when = new Date().toISOString();
  const baseLabel = snapshotLabel(baseRef, snapshots);
  const upstreamLabel =
    args.upstream ?? snapshots.find((row) => row.ref === upstreamRef)?.name ?? upstreamRef;
  const head = `# 上游追踪报告：${baseLabel} → ${upstreamLabel}（对照 ${oursRef}）\n\n生成时间 ${when}\n`;

  const rows = BUCKET_LABELS.map(([label, key]) => [label, key]);
  const table = [
    "| 分类 | 路径数 | 源码类 |",
    "| --- | --- | --- |",
    ...rows.map(
      ([label, key]) =>
        `| ${label} | ${buckets[key].length} | ${buckets[key].filter(isSourcePath).length} |`,
    ),
  ].join("\n");

  console.log(head);
  console.log(table);
  console.log(`\n疑似改名（内容相同的增删对）：${renames.length}`);
  for (const [from, to] of renames.slice(0, args.limit)) console.log(`  ${from} → ${to}`);
  if (renames.length > args.limit)
    console.log(`  … 其余 ${renames.length - args.limit} 对见 --json`);

  printList("真冲突面（双方都改）", buckets.bothChanged.filter(isSourcePath), args.limit);
  printList("上游单方改（可直拿候选）", buckets.upstreamChanged.filter(isSourcePath), args.limit);
  printList("上游删我方留", buckets.upstreamDeletedWeKeep, args.limit);

  if (args.conflicts) {
    const body = [
      `# 真冲突面（双方都改）：${baseLabel} → ${upstreamLabel}，对照 ${oursRef}`,
      `# 生成时间 ${when}`,
      "",
      ...buckets.bothChanged.map((path) => (isSourcePath(path) ? `[源码] ${path}` : path)),
      "",
      "# 上游删我方留",
      ...buckets.upstreamDeletedWeKeep,
    ].join("\n");
    writeFileSync(resolve(args.conflicts), `${body}\n`);
    console.log(`\n冲突清单已写入 ${resolve(args.conflicts)}`);
  }

  if (args.json) {
    writeJson(args.json, {
      generatedAt: when,
      base: baseRef,
      upstream: upstreamRef,
      ours: oursRef,
      counts: bucketCounts(buckets),
      renames: renames.map(([from, to]) => ({ from, to })),
      buckets: bucketPayload(buckets, args.sourceOnly),
    });
  }

  return 0;
}

function main() {
  if (!isGitRepo()) {
    console.error("当前目录不是 git 仓库（本脚本要在仓库根目录执行）");
    return 1;
  }
  const args = parseArgs(process.argv.slice(2));
  return args.command === "status" ? statusReport(args) : diffReport(args);
}

try {
  process.exitCode = (await main()) ?? 0;
} catch (error) {
  console.error(`上游追踪失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
