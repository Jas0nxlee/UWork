import { enterpriseIdentitySessionSchema, type EnterpriseIdentitySession } from "@zcode/shared";
import { z } from "zod";
import type { ICredentialService } from "../credential/credential.js";

export interface IdentitySessionRecord {
  revision: number;
  session: EnterpriseIdentitySession | null;
}
export interface IdentitySessionWrite {
  accepted: boolean;
  record: IdentitySessionRecord;
}
export interface IdentitySessionStore {
  read(): Promise<IdentitySessionRecord>;
  /** 与退出/切换共用身份事务；只允许仍属于同一会话代际的本机副作用提交。 */
  withCurrentSession<T>(
    expected: IdentitySessionRecord,
    operation: (current: IdentitySessionRecord) => Promise<T>,
  ): Promise<T | undefined>;
  write(
    session: EnterpriseIdentitySession | null,
    expectedRevision: number | undefined,
    isCurrent: () => boolean,
    expectedToken?: string,
  ): Promise<IdentitySessionWrite>;
  renew(
    session: EnterpriseIdentitySession,
    expected: IdentitySessionRecord,
    isCurrent: () => boolean,
  ): Promise<IdentitySessionWrite>;
}
const recordSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    session: enterpriseIdentitySessionSchema.nullable(),
  })
  .strict();
const SHARED_KEY = "enterprise-identity:shared-session";

export function matchesSessionRecord(
  current: IdentitySessionRecord,
  expected: IdentitySessionRecord,
) {
  if (current.revision !== expected.revision) return false;
  if (!current.session || !expected.session) return current.session === expected.session;
  // 续期只换 Token，不换代际；退出后重新登录即使同账号同 Token 也必须失效旧操作。
  return (
    current.session.profile.id === expected.session.profile.id &&
    current.session.profile.tenantId === expected.session.profile.tenantId &&
    current.session.profile.provider === expected.session.profile.provider
  );
}

/** 加密会话是设备事实源；文件锁同时覆盖版本比较、写入和取消后的回滚。 */
export function createSharedIdentitySessionStore(
  credentials: ICredentialService,
  transaction: <T>(operation: () => Promise<T>) => Promise<T>,
): IdentitySessionStore {
  const readUnlocked = async (): Promise<{ raw: string | null; record: IdentitySessionRecord }> => {
    const raw = await credentials.load(SHARED_KEY);
    return {
      raw,
      record: raw ? recordSchema.parse(JSON.parse(raw)) : { revision: 0, session: null },
    };
  };
  const mutate = async (
    session: EnterpriseIdentitySession | null,
    expectedRevision: number | undefined,
    expectedToken: string | undefined,
    renewal: boolean,
    isCurrent: () => boolean,
  ): Promise<IdentitySessionWrite> =>
    transaction(async () => {
      const previous = await readUnlocked();
      if (
        !isCurrent() ||
        (expectedRevision !== undefined && expectedRevision !== previous.record.revision) ||
        (expectedToken !== undefined && expectedToken !== previous.record.session?.token)
      )
        return { accepted: false, record: previous.record };
      const record: IdentitySessionRecord = {
        revision: previous.record.revision + (renewal ? 0 : 1),
        session,
      };
      await credentials.save(SHARED_KEY, JSON.stringify(record));
      // 回滚仍在同一跨 Host 锁内，不能误删其它窗口后来接受的新会话。
      if (!isCurrent()) {
        if (previous.raw === null) await credentials.delete(SHARED_KEY);
        else await credentials.save(SHARED_KEY, previous.raw);
        return { accepted: false, record: previous.record };
      }
      return { accepted: true, record };
    });
  return {
    read: () => transaction(async () => (await readUnlocked()).record),
    withCurrentSession: (expected, operation) =>
      transaction(async () => {
        const current = (await readUnlocked()).record;
        return matchesSessionRecord(current, expected) ? operation(current) : undefined;
      }),
    write: (session, revision, isCurrent, expectedToken) =>
      mutate(session, revision, expectedToken, false, isCurrent),
    renew: (session, expected, isCurrent) =>
      mutate(session, expected.revision, expected.session?.token, true, isCurrent),
  };
}

/** 注入测试/单 Host 的兼容端口，保持历史独立客户端增量的凭据格式。 */
export function createLocalIdentitySessionStore(
  credentials: ICredentialService,
): IdentitySessionStore {
  const key = "enterprise-identity:session";
  let revision = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const transaction = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  const read = async (): Promise<IdentitySessionRecord> => {
    const raw = await credentials.load(key);
    return {
      revision,
      session: raw ? enterpriseIdentitySessionSchema.parse(JSON.parse(raw)) : null,
    };
  };
  const write = (
    session: EnterpriseIdentitySession | null,
    expected: number | undefined,
    isCurrent: () => boolean,
    expectedToken?: string,
    renewal = false,
  ) =>
    transaction(async () => {
      const previous = await read();
      if (
        !isCurrent() ||
        (expected !== undefined && expected !== revision) ||
        (expectedToken !== undefined && expectedToken !== previous.session?.token)
      )
        return { accepted: false, record: previous };
      if (session) await credentials.save(key, JSON.stringify(session));
      else await credentials.delete(key);
      if (!isCurrent()) {
        if (previous.session) await credentials.save(key, JSON.stringify(previous.session));
        else await credentials.delete(key);
        return { accepted: false, record: previous };
      }
      revision += renewal ? 0 : 1;
      return { accepted: true, record: { revision, session } };
    });
  return {
    read: () => transaction(read),
    withCurrentSession: (expected, operation) =>
      transaction(async () => {
        const current = await read();
        return matchesSessionRecord(current, expected) ? operation(current) : undefined;
      }),
    write,
    renew: (session, expected, isCurrent) =>
      write(session, expected.revision, isCurrent, expected.session?.token, true),
  };
}
