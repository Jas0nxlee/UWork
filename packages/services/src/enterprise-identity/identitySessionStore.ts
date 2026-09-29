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
    write,
    renew: (session, expected, isCurrent) =>
      write(session, expected.revision, isCurrent, expected.session?.token, true),
  };
}
