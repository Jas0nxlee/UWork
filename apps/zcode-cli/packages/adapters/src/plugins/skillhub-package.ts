// SkillHub（公司 AIHub 技能平台）作为**安装来源**的适配：解析条目 → 取该版本指纹 →
// 下载技能包 → 复算内容指纹校验 → 包装成插件目录（`.zcode-plugin/plugin.json` + `skills/<slug>/`）。
//
// 目录侧（发现/翻页/manifest）见 skillhub-source.ts。
//
// 目录条目里**没有**指纹（compat 列表不返回），指纹只在安装时向原生 `resolve` 取。这条链路能挡住
// 传输损坏、版本漂移与"条目与包不一致"，但不构成对服务端的信任边界 —— 指纹与包同源，
// 恶意服务端可以同时改两者。真正的信任根是内置的来源地址本身。
//
// 本期匿名只读：不发送任何凭据，也不触碰设备码/账号接口。引入账号时，凭据边界（token 只发同源）
// 在这里落地。

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { HttpClientPort } from "@zcode/contracts";
import {
  createSkillhubHttpClient,
  isRecord,
  normalizeSkillhubBaseUrl,
  readFingerprintHex,
  readOptionalTrimmedString,
  readRequiredString,
  requestSkillhubJson,
  SKILLHUB_FALLBACK_API_BASE_PATH,
  SKILLHUB_FINGERPRINT_PREFIX,
  splitNamespaceFromCanonicalSlug,
} from "./skillhub-common.js";
import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";
import { resolveHttpZipSource, type ResolvedZipPluginSourceRoot } from "./zip-source.js";

const PLUGIN_MANIFEST_DIR = ".zcode-plugin";
const PLUGIN_SKILLS_DIR = "skills";
const TEMP_PREFIX = "zcode-skillhub-";

export interface SkillhubPluginSource {
  /** 目录侧发现的 API 基址；安装时据此解析版本与下载地址，避免硬编码 /api/v1 前缀。 */
  apiBase?: string;
  baseUrl: string;
  namespace: string;
  /** 规范 slug（`<namespace>--<slug>` 或 global 下的裸 slug）。 */
  slug: string;
  source: "skillhub";
  version: string;
}

export interface SkillhubResolvedVersion {
  downloadUrl: string;
  fingerprint: string;
}

export interface SkillhubSourceDependencies {
  client?: HttpClientPort;
  resolveZipSource?: typeof resolveHttpZipSource;
}

/** 读取插件条目的 skillhub source；slug/version 缺失即抛错，不做"装个大概"的降级。 */
export function readSkillhubPluginSource(value: unknown): SkillhubPluginSource {
  if (!isRecord(value) || value.source !== "skillhub" || typeof value.baseUrl !== "string") {
    throw new Error("Skillhub plugin source requires a skillhub source object");
  }
  const slug = readRequiredString(value, "slug");
  validateSkillhubSlug(slug);
  const version = readRequiredString(value, "version");
  const namespace =
    typeof value.namespace === "string" && value.namespace.trim().length > 0
      ? value.namespace.trim()
      : splitNamespaceFromCanonicalSlug(slug).namespace;
  const apiBase = readOptionalTrimmedString(value, "apiBase");
  return {
    baseUrl: normalizeSkillhubBaseUrl(value.baseUrl),
    namespace,
    slug,
    source: "skillhub",
    version,
    ...(apiBase ? { apiBase } : {}),
  };
}

/** 解析出该版本的指纹与下载地址（原生 resolve；compat resolve 不返回指纹）。 */
export async function resolveSkillhubVersion(input: {
  client: HttpClientPort;
  plugin: SkillhubPluginSource;
  signal?: AbortSignal;
}): Promise<SkillhubResolvedVersion> {
  const { plugin } = input;
  const apiBase = plugin.apiBase ?? `${plugin.baseUrl}${SKILLHUB_FALLBACK_API_BASE_PATH}`;
  const url = `${apiBase}/skills/${encodeURIComponent(plugin.namespace)}/${encodeURIComponent(
    splitNamespaceFromCanonicalSlug(plugin.slug).slug,
  )}/resolve?version=${encodeURIComponent(plugin.version)}`;
  const { json } = await requestSkillhubJson({ client: input.client, signal: input.signal, url });
  const data = isRecord(json) && isRecord(json.data) ? json.data : {};
  const hex = readFingerprintHex(typeof data.fingerprint === "string" ? data.fingerprint : "");
  if (!hex) {
    throw new Error(
      `Skillhub resolve did not return a fingerprint: ${plugin.slug}@${plugin.version}`,
    );
  }
  const resolvedVersion = typeof data.version === "string" ? data.version.trim() : "";
  if (resolvedVersion && resolvedVersion !== plugin.version) {
    throw new Error(
      `Skillhub resolved version mismatch for ${plugin.slug}: expected=${plugin.version}, resolved=${resolvedVersion}`,
    );
  }
  return {
    downloadUrl: resolveSkillhubDownloadUrl({
      declaredPath: typeof data.downloadUrl === "string" ? data.downloadUrl : undefined,
      plugin,
    }),
    fingerprint: `${SKILLHUB_FINGERPRINT_PREFIX}${hex}`,
  };
}

/**
 * 下载技能包、复算内容指纹、包装成插件目录后交给既有安装管线落缓存。
 *
 * 包装形状：`<pluginRoot>/.zcode-plugin/plugin.json` + `<pluginRoot>/skills/<slug>/…`。
 * 原因：UWork 的插件必须有 manifest，而 SkillHub 的技能包只有 SKILL.md；官方市场的
 * documents/pdf 等插件本身就是同一形状（技能打包成插件）。
 */
export async function resolveSkillhubPluginSource(
  input: { plugin: SkillhubPluginSource; signal?: AbortSignal },
  dependencies: SkillhubSourceDependencies = {},
): Promise<ResolvedZipPluginSourceRoot> {
  validateSkillhubSlug(input.plugin.slug);
  input.signal?.throwIfAborted();
  const client = dependencies.client ?? createSkillhubHttpClient();
  const resolveZipSource = dependencies.resolveZipSource ?? resolveHttpZipSource;
  const resolved = await resolveSkillhubVersion({
    client,
    plugin: input.plugin,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const extracted = await resolveZipSource({
    ...(input.signal ? { signal: input.signal } : {}),
    url: resolved.downloadUrl,
  });
  let pluginRoot: string | undefined;
  try {
    const actual = computeSkillhubFingerprint(await hashSkillDirectory(extracted.path));
    if (actual !== resolved.fingerprint) {
      throw new Error(
        `Skillhub package fingerprint mismatch for ${input.plugin.slug}@${input.plugin.version}: expected=${resolved.fingerprint}, actual=${actual}`,
      );
    }
    pluginRoot = await materializeSkillhubPlugin({
      plugin: input.plugin,
      skillContentRoot: extracted.path,
      signal: input.signal,
    });
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(extracted.cleanup);
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
  const pluginRootPath = pluginRoot;
  const cleanup = async (): Promise<void> => {
    let firstError: unknown;
    try {
      await rm(dirnameOfWrapper(pluginRootPath), { force: true, recursive: true });
    } catch (error) {
      firstError = error;
    }
    try {
      await extracted.cleanup();
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
    if (firstError !== undefined) throw firstError;
  };
  return { cleanup, path: pluginRootPath };
}

/** 服务端的复合指纹：文件按路径升序，逐个拼接 `"<path>:<fileSha256>\n"`（UTF-8）后取 SHA-256。 */
export function computeSkillhubFingerprint(
  files: readonly { path: string; sha256: string }[],
): string {
  const digest = createHash("sha256");
  const sorted = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const file of sorted) {
    digest.update(`${file.path}:${file.sha256.toLowerCase()}\n`, "utf8");
  }
  return `${SKILLHUB_FINGERPRINT_PREFIX}${digest.digest("hex")}`;
}

/** 递归计算目录内每个文件的 sha256；路径转成 posix 形式以对齐服务端记录。 */
export async function hashSkillDirectory(
  rootPath: string,
): Promise<{ path: string; sha256: string }[]> {
  const files: { path: string; sha256: string }[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(absolute);
      files.push({
        path: relative(rootPath, absolute).split(sep).join(posix.sep),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await walk(rootPath);
  return files;
}

/**
 * 下载地址只允许落在市场 origin 上。
 *
 * 注意服务端的 `downloadUrl` 是**应用根相对**的（实测为 `/api/v1/skills/…`，不带部署前缀，
 * 它不像 well-known 那样回显 X-Forwarded-Prefix）。因此不能用 `new URL(path, baseUrl)` ——
 * 路径绝对解析会把 `/skillhub` 这类前缀整段丢掉；要显式把 baseUrl 的路径前缀接回去。
 */
function resolveSkillhubDownloadUrl(input: {
  declaredPath?: string;
  plugin: SkillhubPluginSource;
}): string {
  const { plugin } = input;
  const apiBase = plugin.apiBase ?? `${plugin.baseUrl}${SKILLHUB_FALLBACK_API_BASE_PATH}`;
  const fallback = `${apiBase}/skills/${encodeURIComponent(plugin.namespace)}/${encodeURIComponent(
    splitNamespaceFromCanonicalSlug(plugin.slug).slug,
  )}/versions/${encodeURIComponent(plugin.version)}/download`;
  const declared = input.declaredPath?.trim();
  if (!declared) return fallback;
  const origin = new URL(`${plugin.baseUrl}/`);
  if (/^https?:\/\//iu.test(declared)) {
    const absolute = new URL(declared);
    if (absolute.origin !== origin.origin) {
      throw new Error(`Skillhub download URL must stay on the marketplace origin: ${declared}`);
    }
    return absolute.toString();
  }
  if (!declared.startsWith("/")) {
    throw new Error(`Skillhub download URL must be root-relative or absolute: ${declared}`);
  }
  const prefix = origin.pathname.replace(/\/+$/u, "");
  const path = declared.startsWith(`${prefix}/`) ? declared : `${prefix}${declared}`;
  return `${origin.origin}${path}`;
}

/** 只允许单个目录名；指纹与包同源，不能代替路径边界验证。 */
function validateSkillhubSlug(slug: string): void {
  const segment = "[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*";
  if (!new RegExp(`^${segment}(?:--${segment})?$`, "u").test(slug))
    throw new Error("Invalid Skillhub slug");
}

function dirnameOfWrapper(pluginRoot: string): string {
  return resolve(pluginRoot, "..");
}

async function materializeSkillhubPlugin(input: {
  plugin: SkillhubPluginSource;
  skillContentRoot: string;
  signal?: AbortSignal;
}): Promise<string> {
  validateSkillhubSlug(input.plugin.slug);
  const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const pluginRoot = join(root, "plugin");
  try {
    const skillsRoot = resolve(pluginRoot, PLUGIN_SKILLS_DIR);
    const target = resolve(skillsRoot, input.plugin.slug);
    const child = relative(skillsRoot, target);
    // 复制前独立检查严格后代；不依赖目录条目的校验或平台路径分隔符。
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error("Invalid Skillhub slug target");
    input.signal?.throwIfAborted();
    await mkdir(pluginRoot, { recursive: true });
    await cp(input.skillContentRoot, target, { recursive: true });
    input.signal?.throwIfAborted();
    await mkdir(join(pluginRoot, PLUGIN_MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(pluginRoot, PLUGIN_MANIFEST_DIR, "plugin.json"),
      `${JSON.stringify({ name: input.plugin.slug, version: input.plugin.version, skills: [`./${PLUGIN_SKILLS_DIR}`] }, null, 2)}\n`,
      "utf8",
    );
    input.signal?.throwIfAborted();
    return pluginRoot;
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(() =>
      rm(root, { force: true, recursive: true }),
    );
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}
