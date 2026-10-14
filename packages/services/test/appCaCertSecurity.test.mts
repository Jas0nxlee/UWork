import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSecureContext } from "node:tls";
import test from "node:test";
import { getDataBaseDir, setDataBaseDir } from "../src/paths.js";
import { ensureAppCaCert } from "../src/runtime-tools/appCaCert.js";

test("app CA is a valid RSA root with matching private key and stable persisted identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-app-ca-"));
  const previous = getDataBaseDir();
  setDataBaseDir(root);
  try {
    const certPath = ensureAppCaCert();
    assert.equal(certPath, join(root, ".uwork", "v2", "certs", "zcode-network-ca.pem"));
    const keyPath = join(dirname(certPath), "zcode-network-ca.key");
    const certPem = await readFile(certPath, "utf8");
    const keyPem = await readFile(keyPath, "utf8");
    const cert = new X509Certificate(certPem);
    const key = createPrivateKey(keyPem);
    assert.equal(cert.ca, true);
    assert.equal(cert.subject, cert.issuer);
    assert.match(cert.subject, /CN=ZCode Network CA/);
    assert.match(cert.subject, /O=ZCode/);
    assert.equal(cert.publicKey.asymmetricKeyType, "rsa");
    assert.equal(cert.publicKey.asymmetricKeyDetails?.modulusLength, 2048);
    assert.equal(cert.verify(cert.publicKey), true);
    assert.equal(cert.checkPrivateKey(key), true);
    assert.ok(Date.parse(cert.validTo) - Date.parse(cert.validFrom) > 3650 * 24 * 60 * 60 * 1000);
    assert.doesNotThrow(() => createSecureContext({ cert: certPem, key: keyPem }));
    if (process.platform !== "win32") assert.equal((await stat(keyPath)).mode & 0o777, 0o600);

    assert.equal(ensureAppCaCert(), certPath);
    assert.equal(await readFile(certPath, "utf8"), certPem);
    assert.equal(await readFile(keyPath, "utf8"), keyPem);

    // 旧版生成的完整文件对仍按原路径复用，不能因更换编码库强制换根证书。
    await writeFile(certPath, certPem + "\n");
    assert.equal(ensureAppCaCert(), certPath);
    assert.equal(await readFile(certPath, "utf8"), certPem + "\n");
  } finally {
    setDataBaseDir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
