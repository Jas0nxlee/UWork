import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  AttributeValue,
  BasicConstraints,
  Certificate,
  Extension,
  Extensions,
  KeyUsage,
  KeyUsageFlags,
  Name,
  RelativeDistinguishedName,
  SubjectKeyIdentifier,
  SubjectPublicKeyInfo,
  TBSCertificate,
  Validity,
  Version,
  id_ce_basicConstraints,
  id_ce_keyUsage,
  id_ce_subjectKeyIdentifier,
} from "@peculiar/asn1-x509";
import { getAppConfigDir } from "../paths.js";

// app 场景的自签 CA（区别于 debug 抓包代理那套，仅 debug 环境用）。
// 程序首次启动时生成一份自签根 CA，公钥证书供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任，
// 私钥供出口代理做 TLS 重签。已存在则原样复用，保证证书指纹稳定、被信任后不漂移。

const APP_CA_CERT_FILE = "zcode-network-ca.pem";
const APP_CA_KEY_FILE = "zcode-network-ca.key";
const CA_VALIDITY_YEARS = 10;
const CA_KEY_BITS = 2048;

interface AppCaCertPaths {
  certPath: string;
  keyPath: string;
}

function getAppCaCertPaths(): AppCaCertPaths {
  const certDir = join(getAppConfigDir(), "certs");
  return {
    certPath: join(certDir, APP_CA_CERT_FILE),
    keyPath: join(certDir, APP_CA_KEY_FILE),
  };
}

/**
 * 确保 app 自签 CA 存在；缺失时生成一份。返回证书（公钥）路径。
 * 幂等：证书与私钥都已存在时直接返回，不重新生成。
 */
export function ensureAppCaCert(): string {
  const { certPath, keyPath } = getAppCaCertPaths();
  if (existsSync(certPath) && existsSync(keyPath)) {
    return certPath;
  }

  const { certPem, keyPem } = generateSelfSignedCa();
  mkdirSync(join(getAppConfigDir(), "certs"), { recursive: true });
  // 私钥含敏感材料，权限收紧到 0600；公钥证书可读。
  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  return certPath;
}

function generateSelfSignedCa(): { certPem: string; keyPem: string } {
  // node-forge 的 RSA 验签公告尚无修复版；移除该运行时依赖，由 Node/OpenSSL
  // 负责密钥与 SHA-256 签名，ASN.1 库只编码 RFC 5280 结构，保持原有 CA 文件格式。
  // 结构定义：https://github.com/PeculiarVentures/asn1-schema/tree/master/packages/x509/src
  const keys = generateKeyPairSync("rsa", { modulusLength: CA_KEY_BITS });
  const publicKey = AsnConvert.parse(
    new Uint8Array(keys.publicKey.export({ type: "spki", format: "der" })).buffer,
    SubjectPublicKeyInfo,
  );
  const algorithm = new AlgorithmIdentifier({
    algorithm: "1.2.840.113549.1.1.11",
    parameters: null,
  });
  // 用密码学随机数做序列号，首字节清零避免被解析成负数。
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);
  const name = new Name([
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: "2.5.4.3",
        value: new AttributeValue({ utf8String: "ZCode Network CA" }),
      }),
    ]),
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: "2.5.4.10",
        value: new AttributeValue({ utf8String: "ZCode" }),
      }),
    ]),
  ]);
  const tbsCertificate = new TBSCertificate({
    version: Version.v3,
    serialNumber: new Uint8Array(serial).buffer,
    signature: algorithm,
    issuer: name,
    subject: name,
    validity: new Validity({ notBefore, notAfter }),
    subjectPublicKeyInfo: publicKey,
    extensions: new Extensions([
      new Extension({
        extnID: id_ce_basicConstraints,
        critical: true,
        extnValue: new OctetString(AsnConvert.serialize(new BasicConstraints({ cA: true }))),
      }),
      new Extension({
        extnID: id_ce_keyUsage,
        critical: true,
        extnValue: new OctetString(
          AsnConvert.serialize(
            new KeyUsage(
              KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign | KeyUsageFlags.digitalSignature,
            ),
          ),
        ),
      }),
      new Extension({
        extnID: id_ce_subjectKeyIdentifier,
        // RFC 5280 4.2.1.2 的 SHA-1 仅用于公钥标识，不用于证书签名。
        extnValue: new OctetString(
          AsnConvert.serialize(
            new SubjectKeyIdentifier(
              createHash("sha1").update(Buffer.from(publicKey.subjectPublicKey)).digest(),
            ),
          ),
        ),
      }),
    ]),
  });
  const certificate = new Certificate({
    tbsCertificate,
    signatureAlgorithm: algorithm,
    signatureValue: new Uint8Array(
      sign("sha256", Buffer.from(AsnConvert.serialize(tbsCertificate)), keys.privateKey),
    ).buffer,
  });
  const encoded = Buffer.from(AsnConvert.serialize(certificate)).toString("base64");
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
    keyPem: keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
}
