import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateEncrypt, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
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
