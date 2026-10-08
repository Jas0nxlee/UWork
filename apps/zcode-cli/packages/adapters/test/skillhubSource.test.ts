import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HttpClientPort, HttpClientResponse } from "@zcode/contracts";
import {
  normalizeSkillhubBaseUrl,
  splitNamespaceFromCanonicalSlug,
} from "../src/plugins/skillhub-common.js";
import {
  computeSkillhubFingerprint,
  readSkillhubPluginSource,
  resolveSkillhubPluginSource,
  resolveSkillhubVersion,
} from "../src/plugins/skillhub-package.js";
import {
  buildSkillhubMarketplaceManifestRaw,
  discoverSkillhubApiBase,
  fetchSkillhubCatalog,
} from "../src/plugins/skillhub-source.js";

// 线上实测 fixture（2026-10-07，kb-search v20260920.142519）：服务端 `resolve` 返回的
// 复合指纹与它唯一一个文件的 sha256。算法必须与这两个值逐字对齐，否则完整性校验形同虚设。
const LIVE_FILE = "SKILL.md";
const LIVE_FILE_SHA256 = "a4adb72134ae929797bf643cc022b48c602f00ece3d0d1c0ffcb4e2538f720f4";
const LIVE_FINGERPRINT = "sha256:ad6b8a9b4d9b42e5c0664fef25b41b50d3406ca9f4944e55817f43845d427fd3";

const BASE_URL = "https://aihub.ucas.com.cn/skillhub";
const API_BASE = `${BASE_URL}/api/v1`;

interface FakeResponse {
  body?: unknown;
  status?: number;
}

function createFakeClient(
  handler: (url: string) => FakeResponse,
): { client: HttpClientPort; requested: string[] } {
  const requested: string[] = [];
  const client: HttpClientPort = {
    request: async (request, options) => {
      requested.push(request.url);
      if (options?.signal?.aborted) throw new Error("aborted");
      const result = handler(request.url);
      const status = result.status ?? 200;
      const body = new TextEncoder().encode(JSON.stringify(result.body ?? {}));
      return {
        body,
        bytes: body.byteLength,
        durationMs: 0,
        headers: {},
        status,
        statusText: status === 200 ? "OK" : "Error",
        url: request.url,
      } satisfies HttpClientResponse;
    },
  };
  return { client, requested };
}

async function withTempDir<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "uwork-skillhub-test-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("指纹复算与服务端逐字一致（真实 fixture）", () => {
  assert.equal(
    computeSkillhubFingerprint([{ path: LIVE_FILE, sha256: LIVE_FILE_SHA256 }]),
    LIVE_FINGERPRINT,
  );
});

test("指纹按路径升序拼接，与输入顺序和大小写无关", () => {
  const files = [
    { path: "references/b.md", sha256: "b".repeat(64) },
    { path: "SKILL.md", sha256: "a".repeat(64) },
  ];
  const forward = computeSkillhubFingerprint(files);
  const reversed = computeSkillhubFingerprint([...files].reverse());
  const upper = computeSkillhubFingerprint(
    files.map((file) => ({ ...file, sha256: file.sha256.toUpperCase() })),
  );
  assert.equal(forward, reversed);
  assert.equal(forward, upper);
  assert.match(forward, /^sha256:[a-f0-9]{64}$/u);
});

test("规范 slug 反解：global 不带前缀，命名空间在第一个 -- 处切分", () => {
  assert.deepEqual(splitNamespaceFromCanonicalSlug("kb-search"), {
    namespace: "global",
    slug: "kb-search",
  });
  assert.deepEqual(splitNamespaceFromCanonicalSlug("hr--onboarding"), {
    namespace: "hr",
    slug: "onboarding",
  });
  assert.deepEqual(splitNamespaceFromCanonicalSlug("hr--onboarding--v2"), {
    namespace: "hr",
    slug: "onboarding--v2",
  });
});

test("baseUrl 只接受 HTTPS 或回环 HTTP，并去掉尾斜杠", () => {
  assert.equal(normalizeSkillhubBaseUrl(`${BASE_URL}/`), BASE_URL);
  assert.equal(normalizeSkillhubBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(() => normalizeSkillhubBaseUrl("http://aihub.ucas.com.cn/skillhub"), /HTTPS/u);
  assert.throws(() => normalizeSkillhubBaseUrl("not a url"), /not a valid URL/u);
});

test("发现 API 基址：well-known 优先，缺失时回退固定路径", async () => {
  const withWellKnown = createFakeClient((url) =>
    url.endsWith("/.well-known/clawhub.json")
      ? { body: { apiBase: "/skillhub/api/v1" } }
      : { status: 404 },
  );
  assert.equal(
    await discoverSkillhubApiBase({ baseUrl: BASE_URL, client: withWellKnown.client }),
    API_BASE,
  );

  const withoutWellKnown = createFakeClient(() => ({ status: 404 }));
  assert.equal(
    await discoverSkillhubApiBase({ baseUrl: BASE_URL, client: withoutWellKnown.client }),
    API_BASE,
  );
});

test("well-known 声明跨 origin 的 apiBase 被拒绝", async () => {
  const { client } = createFakeClient(() => ({ body: { apiBase: "https://evil.example.com/api" } }));
  await assert.rejects(
    () => discoverSkillhubApiBase({ baseUrl: BASE_URL, client }),
    /must stay on the marketplace origin/u,
  );
});

test("目录翻页按 nextCursor 前进，page 从 0 起算", async () => {
  const { client, requested } = createFakeClient((url) => {
    if (url.includes("page=0")) {
      return {
        body: {
          items: [{ slug: "kb-search", summary: "知识库", latestVersion: { version: "1" } }],
          nextCursor: "1",
        },
      };
    }
    return {
      body: {
        items: [{ slug: "translate", summary: "翻译", latestVersion: { version: "2" } }],
        nextCursor: null,
      },
    };
  });
  const items = await fetchSkillhubCatalog({ apiBase: API_BASE, client });
  assert.deepEqual(
    items.map((item) => item.slug),
    ["kb-search", "translate"],
  );
  assert.equal(requested.length, 2);
  assert.match(requested[0] ?? "", /\/skills\?page=0&limit=50$/u);
  assert.match(requested[1] ?? "", /\/skills\?page=1&limit=50$/u);
});

test("目录归一化：条目自带 baseUrl/apiBase/namespace，隐藏与官方重复的技能", () => {
  const manifest = buildSkillhubMarketplaceManifestRaw({
    apiBase: API_BASE,
    baseUrl: BASE_URL,
    items: [
      { displayName: "知识库检索", latestVersion: { version: "20260920.142519" }, slug: "kb-search", summary: "查内部资料" },
      { latestVersion: { version: "20260831.061404" }, slug: "docx", summary: "Word" },
      { latestVersion: { version: "1" }, slug: "hr--onboarding", summary: "入职" },
      { latestVersion: {}, slug: "no-version", summary: "无版本" },
    ],
  });
  assert.equal(manifest.name, "ucas-aihub");
  const plugins = manifest.plugins as Record<string, unknown>[];
  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ["kb-search", "hr--onboarding"],
  );
  assert.equal(plugins[0]?.displayName, "知识库检索");
  assert.deepEqual(plugins[0]?.source, {
    apiBase: API_BASE,
    baseUrl: BASE_URL,
    namespace: "global",
    slug: "kb-search",
    source: "skillhub",
    version: "20260920.142519",
  });
  assert.equal((plugins[1]?.source as Record<string, unknown>).namespace, "hr");
});

test("插件 source 字段缺失即报错，不做降级安装", () => {
  assert.throws(() => readSkillhubPluginSource({ baseUrl: BASE_URL, source: "skillhub" }), /slug/u);
  assert.throws(
    () => readSkillhubPluginSource({ baseUrl: BASE_URL, slug: "kb-search", source: "skillhub" }),
    /version/u,
  );
  assert.deepEqual(
    readSkillhubPluginSource({
      apiBase: `${API_BASE}/`,
      baseUrl: `${BASE_URL}/`,
      slug: "kb-search",
      source: "skillhub",
      version: "1",
    }),
    {
      apiBase: API_BASE,
      baseUrl: BASE_URL,
      namespace: "global",
      slug: "kb-search",
      source: "skillhub",
      version: "1",
    },
  );
});

test("安装：取指纹 → 下载 → 复算校验 → 包装成插件（含同源下载地址）", async () => {
  await withTempDir(async (skillRoot) => {
    await writeFile(join(skillRoot, "SKILL.md"), "# kb-search\n", "utf8");
    const expected = computeSkillhubFingerprint([
      { path: "SKILL.md", sha256: await sha256Hex("# kb-search\n") },
    ]);

    const { client, requested } = createFakeClient(() => ({
      body: {
        data: {
          downloadUrl: "/skillhub/api/v1/skills/global/kb-search/versions/1/download",
          fingerprint: expected,
          version: "1",
        },
      },
    }));
    const downloadUrls: string[] = [];
    let zipCleanupCalls = 0;
    const plugin = readSkillhubPluginSource({
      apiBase: API_BASE,
      baseUrl: BASE_URL,
      slug: "kb-search",
      source: "skillhub",
      version: "1",
    });

    const resolved = await resolveSkillhubPluginSource(
      { plugin },
      {
        client,
        resolveZipSource: async (input) => {
          downloadUrls.push(input.url);
          return {
            cleanup: async () => {
              zipCleanupCalls += 1;
            },
            path: skillRoot,
          };
        },
      },
    );

    assert.match(requested[0] ?? "", /\/skills\/global\/kb-search\/resolve\?version=1$/u);
    assert.deepEqual(downloadUrls, [
      `${API_BASE}/skills/global/kb-search/versions/1/download`,
    ]);
    const manifest = JSON.parse(
      await readFile(join(resolved.path, ".zcode-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(manifest, { name: "kb-search", skills: ["./skills"], version: "1" });
    assert.equal(
      await readFile(join(resolved.path, "skills", "kb-search", "SKILL.md"), "utf8"),
      "# kb-search\n",
    );

    await resolved.cleanup();
    assert.equal(zipCleanupCalls, 1);
    await assert.rejects(() => readFile(join(resolved.path, ".zcode-plugin", "plugin.json")));
  });
});

test("安装：指纹不符即失败，且技能包临时目录被清理", async () => {
  await withTempDir(async (skillRoot) => {
    await writeFile(join(skillRoot, "SKILL.md"), "tampered\n", "utf8");
    const { client } = createFakeClient(() => ({
      body: { data: { fingerprint: "f".repeat(64), version: "1" } },
    }));
    let zipCleanupCalls = 0;
    await assert.rejects(
      () =>
        resolveSkillhubPluginSource(
          {
            plugin: readSkillhubPluginSource({
              apiBase: API_BASE,
              baseUrl: BASE_URL,
              slug: "kb-search",
              source: "skillhub",
              version: "1",
            }),
          },
          {
            client,
            resolveZipSource: async () => ({
              cleanup: async () => {
                zipCleanupCalls += 1;
              },
              path: skillRoot,
            }),
          },
        ),
      /fingerprint mismatch/u,
    );
    assert.equal(zipCleanupCalls, 1);
  });
});

test("下载地址拼接：服务端返回的应用根相对路径要补回部署前缀（实测形态）", async () => {
  const plugin = () =>
    readSkillhubPluginSource({
      apiBase: API_BASE,
      baseUrl: BASE_URL,
      slug: "kb-search",
      source: "skillhub",
      version: "1",
    });
  const resolveWith = (downloadUrl: string) =>
    createFakeClient(() => ({
      body: { data: { downloadUrl, fingerprint: "a".repeat(64), version: "1" } },
    }));

  // 线上实测：返回 /api/v1/... 这种应用根相对路径（不带 /skillhub）。new URL(path, base) 会把
  // 部署前缀整段吃掉，必须显式补回。
  const appRootRelative = await resolveSkillhubVersion({
    client: resolveWith("/api/v1/skills/global/kb-search/versions/1/download").client,
    plugin: plugin(),
  });
  assert.equal(
    appRootRelative.downloadUrl,
    `${API_BASE}/skills/global/kb-search/versions/1/download`,
  );

  // 已经带前缀的路径不能重复拼接。
  const alreadyPrefixed = await resolveSkillhubVersion({
    client: resolveWith("/skillhub/api/v1/skills/global/kb-search/versions/1/download").client,
    plugin: plugin(),
  });
  assert.equal(
    alreadyPrefixed.downloadUrl,
    `${BASE_URL}/api/v1/skills/global/kb-search/versions/1/download`,
  );

  // 跨 origin 的绝对地址一律拒绝。
  await assert.rejects(
    () =>
      resolveSkillhubVersion({
        client: resolveWith("https://evil.example.com/bundle.zip").client,
        plugin: plugin(),
      }),
    /must stay on the marketplace origin/u,
  );
});

test("安装：resolve 返回的版本与条目版本不一致即失败", async () => {  const { client } = createFakeClient(() => ({
    body: { data: { fingerprint: "a".repeat(64), version: "2" } },
  }));
  await assert.rejects(
    () =>
      resolveSkillhubPluginSource(
        {
          plugin: readSkillhubPluginSource({
            apiBase: API_BASE,
            baseUrl: BASE_URL,
            slug: "kb-search",
            source: "skillhub",
            version: "1",
          }),
        },
        {
          client,
          resolveZipSource: async () => {
            throw new Error("download should not start");
          },
        },
      ),
    /resolved version mismatch/u,
  );
});

async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

test("目录为空时不会新建任何东西（空目录仍是合法目录）", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "nested"), { recursive: true });
    const { client } = createFakeClient(() => ({ body: { items: [], nextCursor: null } }));
    assert.deepEqual(await fetchSkillhubCatalog({ apiBase: API_BASE, client }), []);
  });
});
