import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateEncrypt, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("debug forge rejects nested DigestAlgorithm garbage while accepting normal RSA signatures", () => {
  const forge = require("node-forge");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = forge.pki.publicKeyFromPem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const message = "fixture RSA signature";
  const digest = forge.md.sha256.create().update(message).digest().getBytes();
  assert.equal(
    publicKey.verify(
      digest,
      sign("sha256", Buffer.from(message), keys.privateKey).toString("binary"),
    ),
    true,
  );

  // CVE-2026-85393：旧版仅校验外层 DigestInfo 元素数，嵌套算法中的额外字节仍被接受。
  // 使用真实密钥对构造畸形 PKCS#1 block，确保回归测试验证拒绝语义而非补丁字面量。
  const asn1 = forge.asn1;
  const algorithm = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.OID,
      false,
      asn1.oidToDer(forge.oids.sha256).getBytes(),
    ),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, "fixture garbage"),
  ]);
  const info = asn1
    .toDer(
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        algorithm,
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
      ]),
    )
    .getBytes();
  const block = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.alloc(256 - info.length - 3, 0xff),
    Buffer.from([0]),
    Buffer.from(info, "binary"),
  ]);
  const signature = privateEncrypt(
    { key: keys.privateKey, padding: constants.RSA_NO_PADDING },
    block,
  );
  assert.throws(() => publicKey.verify(digest, signature.toString("binary")), /DigestInfo/);
});

test("vendored shadcn variants still compile Radix state and orientation selectors", async () => {
  const { compile } = require("tailwindcss");
  const css = await readFile(
    new URL("../../packages/ui/src/styles/shadcn-4.1.1.css", import.meta.url),
    "utf8",
  );
  const compiler = await compile(
    css + "\n@utility fixture-display { display: block; }\n@tailwind utilities;\n",
  );
  const output = compiler.build([
    "data-active:fixture-display",
    "data-disabled:fixture-display",
    "data-horizontal:fixture-display",
    "data-vertical:fixture-display",
    "no-scrollbar",
  ]);
  assert.match(output, /data-state=["']?active/);
  assert.match(output, /data-active/);
  assert.match(output, /:not\(\[data-disabled=["']?false/);
  assert.match(output, /data-orientation=["']?horizontal/);
  assert.match(output, /data-orientation=["']?vertical/);
  assert.match(output, /scrollbar-width: none/);
});

const fromExcel = createRequire(require.resolve("exceljs"));
const fromArchiver = createRequire(fromExcel.resolve("archiver"));
const fromGlob = createRequire(
  createRequire(fromArchiver.resolve("archiver-utils")).resolve("glob"),
);
const fromGlobMatcher = createRequire(fromGlob.resolve("minimatch"));
const fromReaddirMatcher = createRequire(
  createRequire(fromArchiver.resolve("readdir-glob")).resolve("minimatch"),
);

for (const [field, value] of [
  ["prefix", "../escaped"],
  ["postfix", "/../../escaped"],
] as const) {
  test(`ExcelJS tmp rejects traversal in ${field}`, async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "uwork-tmp-security-")));
    const base = join(parent, "base");
    await mkdir(base);
    let created: ReturnType<typeof import("tmp").fileSync> | undefined;
    try {
      assert.throws(() => {
        created = fromExcel("tmp").fileSync({ tmpdir: base, [field]: value });
      }, /Relative value not allowed/);
    } finally {
      created?.removeCallback();
      await rm(parent, { recursive: true, force: true });
    }
  });
}

test("ExcelJS tmp still creates and cleans normal temporary files", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "uwork-tmp-normal-")));
  let created: ReturnType<typeof import("tmp").fileSync> | undefined;
  try {
    created = fromExcel("tmp").fileSync({ tmpdir: parent, prefix: "worksheet", postfix: ".xml" });
    assert.equal((await readFile(created!.name)).length, 0);
    assert.ok(created!.name.startsWith(parent + "/") || created!.name.startsWith(parent + "\\"));
  } finally {
    created?.removeCallback();
    await rm(parent, { recursive: true, force: true });
  }
});

for (const [line, scopedRequire] of [
  ["1.x", fromGlobMatcher],
  ["2.x", fromReaddirMatcher],
] as const) {
  test(`archiver brace-expansion ${line} preserves normal output and bounds nesting/results`, () => {
    const expand = scopedRequire("brace-expansion");
    assert.deepEqual(expand("report-{a,b}.xlsx"), ["report-a.xlsx", "report-b.xlsx"]);
    const nested = "{".repeat(3200) + "a,b" + "}".repeat(3200);
    let result: string[] = [];
    assert.doesNotThrow(() => {
      result = expand(nested);
    });
    assert.ok(result.length <= 2);
    assert.ok(expand("{1..100}", { max: 5 }).length <= 5);
  });
}

async function redirectHeaders(headers: object | string[], sensitiveHeaders?: string[]) {
  const destination = createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify(req.headers));
  });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  const destinationPort = (destination.address() as import("node:net").AddressInfo).port;
  const source = createServer((req, res) => {
    req.resume();
    res.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/destination` });
    res.end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  try {
    const port = (source.address() as import("node:net").AddressInfo).port;
    // 原始数组头必须显式带 Host；Node 不会像对象头那样自动填充它。
    const requestHeaders = Array.isArray(headers)
      ? [...headers, "Host", `127.0.0.1:${port}`]
      : headers;
    return await new Promise<Record<string, string>>((resolve, reject) => {
      createRequire(new URL("../../packages/server/package.json", import.meta.url))(
        "follow-redirects",
      )
        .http.get(
          `http://127.0.0.1:${port}/source`,
          { headers: requestHeaders, sensitiveHeaders },
          (response: import("node:http").IncomingMessage) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("error", reject);
            response.on("end", () => {
              try {
                resolve(JSON.parse(body));
              } catch (error) {
                reject(error);
              }
            });
          },
        )
        .on("error", reject);
    });
  } finally {
    await Promise.all(
      [source, destination].map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
}

test("cross-origin redirects strip credentials from array-form headers", async () => {
  const headers = await redirectHeaders([
    "Authorization",
    "fixture-token",
    "Cookie",
    "fixture=session",
    "Proxy-Authorization",
    "fixture-proxy",
    "X-Public",
    "kept",
  ]);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers["proxy-authorization"], undefined);
  assert.equal(headers["x-public"], "kept");
});

test("cross-origin redirects treat regex metacharacters in sensitive header names literally", async () => {
  const headers = await redirectHeaders(
    { "X-Api^Key": "fixture-secret", "X-Token|Secret": "fixture-other", "X-Public": "kept" },
    ["X-Api^Key", "X-Token|Secret"],
  );
  assert.equal(headers["x-api^key"], undefined);
  assert.equal(headers["x-token|secret"], undefined);
  assert.equal(headers["x-public"], "kept");
});

for (const shape of ["array", "object"] as const) {
  test(`ExcelJS tmp rejects non-string ${shape} prefixes before path coercion`, async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "uwork-tmp-type-security-")));
    const base = join(parent, "base");
    await mkdir(base);
    let created: ReturnType<typeof import("tmp").fileSync> | undefined;
    const prefix =
      shape === "array" ? ["../escaped"] : { includes: () => false, toString: () => "../escaped" };
    try {
      assert.throws(() => {
        created = fromExcel("tmp").fileSync({ tmpdir: base, prefix });
      }, /prefix option must be a string/);
    } finally {
      created?.removeCallback();
      await rm(parent, { recursive: true, force: true });
    }
  });
}

test("the existing tmp-promise wrapper preserves async file creation and cleanup", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "uwork-tmp-promise-")));
  let created: Awaited<ReturnType<typeof import("tmp-promise").file>> | undefined;
  try {
    created = await require("tmp-promise").file({ tmpdir: parent, prefix: "wrapper" });
    assert.equal((await readFile(created!.path)).length, 0);
    const path = created!.path;
    await created!.cleanup();
    created = undefined;
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await created?.cleanup();
    await rm(parent, { recursive: true, force: true });
  }
});
