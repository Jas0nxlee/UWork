import { z } from "zod";

export const SOURCE_SERVER_RELEASE_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;
export const SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME = "source-server-release.json";

/** 远端正向发行归档的基名：`uwork-server-<target>.tar.gz`（descriptor 的 fileName 与之对应）。 */
export const SOURCE_SERVER_ARCHIVE_BASENAME = "uwork-server";
/** 兼容基名：3.16.2 之前发布的 descriptor/archive 用的是 `zcode-server-<target>.tar.gz`。 */
export const LEGACY_SOURCE_SERVER_ARCHIVE_BASENAME = "zcode-server";

export const sourceServerArtifactPolicySchema = z.enum([
  "release-versioned",
  "development-content-addressed",
]);
export type SourceServerArtifactPolicy = z.infer<typeof sourceServerArtifactPolicySchema>;

export const sourceServerReleaseTargetSchema = z.enum(SOURCE_SERVER_RELEASE_TARGETS);
export type SourceServerReleaseTarget = z.infer<typeof sourceServerReleaseTargetSchema>;

const releaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    if (/^https?:\/\//u.test(value)) return true;
    return (
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }, "Source Server release URL must be HTTP(S) or a safe relative path");

export const sourceServerReleaseArchiveSchema = z
  .object({
    target: sourceServerReleaseTargetSchema,
    version: z.string().trim().min(1),
    fileName: z.string().trim().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sizeBytes: z.number().int().positive(),
    urls: z.array(releaseUrlSchema).min(1),
  })
  .strict()
  .superRefine((archive, context) => {
    // 接受新基名与旧基名：已发布的 CDN descriptor（含 cached descriptor）仍是旧基名，
    // 变更身份后必须继续可解析，否则旧版本升级会因 descriptor 校验失败而无法更新。
    const expectedFileNames = [
      `${SOURCE_SERVER_ARCHIVE_BASENAME}-${archive.target}.tar.gz`,
      `${LEGACY_SOURCE_SERVER_ARCHIVE_BASENAME}-${archive.target}.tar.gz`,
    ];
    if (!expectedFileNames.includes(archive.fileName)) {
      context.addIssue({
        code: "custom",
        path: ["fileName"],
        message: `Source Server release fileName must be ${expectedFileNames.join(" or ")}`,
      });
    }
  });

export type SourceServerReleaseArchive = z.infer<typeof sourceServerReleaseArchiveSchema>;

export const sourceServerReleaseDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().trim().min(1),
    archives: z.array(sourceServerReleaseArchiveSchema).min(1),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const targets = new Set<SourceServerReleaseTarget>();
    descriptor.archives.forEach((archive, index) => {
      if (archive.version !== descriptor.version) {
        context.addIssue({
          code: "custom",
          path: ["archives", index, "version"],
          message: "Source Server archive version must match descriptor version",
        });
      }
      if (targets.has(archive.target)) {
        context.addIssue({
          code: "custom",
          path: ["archives", index, "target"],
          message: `Duplicate Source Server release target: ${archive.target}`,
        });
      }
      targets.add(archive.target);
    });
  });

export type SourceServerReleaseDescriptor = z.infer<typeof sourceServerReleaseDescriptorSchema>;
