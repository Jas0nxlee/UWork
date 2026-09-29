import { Emitter } from "@zcode/rpc";
import {
  enterpriseIdentityAttemptSchema,
  enterpriseIdentityPollResultSchema,
  enterpriseIdentitySessionSchema,
  type EnterpriseIdentityAttempt,
  type EnterpriseIdentitySession,
  type EnterpriseIdentityView,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { EnterpriseIdentityAdapter, IEnterpriseIdentityService } from "./contract.js";

const SESSION_KEY = "enterprise-identity:session";
const logger = createServiceLogger("enterprise-identity");

export function createEnterpriseIdentityService(options: {
  credentials: ICredentialService;
  adapter?: EnterpriseIdentityAdapter;
  now?: () => number;
}): IEnterpriseIdentityService {
  const { credentials, adapter } = options;
  const now = options.now ?? Date.now;
  const changed = new Emitter<EnterpriseIdentityView>();
  let view: EnterpriseIdentityView = {
    revision: 0,
    configured: Boolean(adapter),
    status: "signed-out",
    profile: null,
    pending: null,
    error: adapter ? null : "unconfigured",
  };
  let generation = 0;
  let controller = new AbortController();
  let session: EnterpriseIdentitySession | null = null;
  let attempt: EnterpriseIdentityAttempt | null = null;
  let startTask: Promise<EnterpriseIdentityAttempt> | null = null;
  let pollTask: Promise<EnterpriseIdentityView> | null = null;
  let restoreTask: Promise<EnterpriseIdentityView> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const publish = (next: Omit<EnterpriseIdentityView, "revision" | "configured">) => {
    view = {
      ...next,
      revision: view.revision + 1,
      configured: Boolean(adapter),
    } as EnterpriseIdentityView;
    changed.fire(structuredClone(view));
  };
  const signedOut = (error: EnterpriseIdentityView["error"] = null) =>
    publish({ status: "signed-out", profile: null, pending: null, error });
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation);
    writes = result.catch(() => {});
    return result;
  };
  const invalidate = () => {
    generation++;
    controller.abort();
    controller = new AbortController();
    attempt = null;
    startTask = null;
    pollTask = null;
    restoreTask = null;
    return generation;
  };
  const expireSession = async () => {
    if (!session || session.expiresAt > now()) return;
    invalidate();
    session = null;
    signedOut("expired");
    await enqueue(() => credentials.delete(SESSION_KEY));
  };
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    if (!session) return;
    expiryTimer = setTimeout(
      () => {
        // 身份不是永久标签；按服务端有效期清除投影，不能一直展示过期姓名。
        void expireSession()
          .then(scheduleExpiry)
          .catch(() => logger.warn(undefined, "Expired session cleanup failed"));
      },
      Math.min(Math.max(1, session.expiresAt - now()), 2147483647),
    );
    expiryTimer.unref();
  };
  const commit = async (value: EnterpriseIdentitySession, current: number) => {
    const validated = enterpriseIdentitySessionSchema.parse(value);
    if (validated.expiresAt <= now()) throw new Error("企业登录会话已过期");
    await enqueue(async () => {
      if (current !== generation) return;
      await credentials.save(SESSION_KEY, JSON.stringify(validated));
      // 取消可能发生在磁盘 IO 中途；同一写队列内回滚未接受的凭据，防止下次启动复活已取消的身份。
      if (current !== generation) {
        await credentials.delete(SESSION_KEY);
        return;
      }
      session = validated;
      scheduleExpiry();
      attempt = null;
      publish({ status: "authenticated", profile: validated.profile, pending: null, error: null });
      logger.info(undefined, "Enterprise session authenticated");
    });
  };
  const fail = (current: number) => {
    if (current === generation) {
      attempt = null;
      signedOut("failed");
      logger.warn(undefined, "Enterprise authentication failed");
    }
  };
  const service: IEnterpriseIdentityService = {
    onDidChange: changed.event,
    async getView() {
      await expireSession();
      return structuredClone(view);
    },
    restoreSession() {
      if (restoreTask) return restoreTask;
      if (!adapter || view.status !== "signed-out") return service.getView();
      const current = generation;
      const signal = controller.signal;
      const task = (async () => {
        try {
          const raw = await credentials.load(SESSION_KEY);
          if (current !== generation || !raw) return service.getView();
          const parsed = enterpriseIdentitySessionSchema.safeParse(JSON.parse(raw));
          const restored =
            parsed.success && parsed.data.expiresAt > now()
              ? await adapter.restore(parsed.data, signal)
              : null;
          if (current !== generation) return service.getView();
          if (restored) await commit(restored, current);
          else
            await enqueue(async () => {
              if (current !== generation) return;
              await credentials.delete(SESSION_KEY);
              if (current === generation) signedOut("expired");
            });
          return service.getView();
        } catch {
          fail(current);
          throw new Error("企业登录状态恢复失败，请重试或跳过登录");
        }
      })();
      restoreTask = task;
      void task
        .finally(() => {
          if (restoreTask === task) restoreTask = null;
        })
        .catch(() => {});
      return task;
    },
    beginLogin() {
      if (!adapter) return Promise.reject(new Error("企业微信登录暂未配置"));
      if (startTask) return startTask;
      if (attempt && attempt.expiresAt > now()) return Promise.resolve(structuredClone(attempt));
      if (view.status === "authenticated") return Promise.reject(new Error("请先退出当前企业账号"));
      const current = invalidate();
      const signal = controller.signal;
      const task = (async () => {
        try {
          const started = enterpriseIdentityAttemptSchema.parse(await adapter.start(signal));
          if (current !== generation) throw new Error("企业登录已取消");
          if (started.expiresAt <= now()) throw new Error("企业登录链接已过期");
          attempt = started;
          publish({
            status: "waiting",
            profile: null,
            pending: { id: started.id, expiresAt: started.expiresAt },
            error: null,
          });
          return structuredClone(started);
        } catch {
          fail(current);
          throw new Error("企业微信登录失败，请重试或跳过登录");
        }
      })();
      startTask = task;
      void task
        .finally(() => {
          if (startTask === task) startTask = null;
        })
        .catch(() => {});
      return task;
    },
    pollLogin(attemptId) {
      if (!adapter || !attempt || attempt.id !== attemptId) return service.getView();
      if (pollTask) return pollTask;
      if (attempt.expiresAt <= now()) {
        invalidate();
        signedOut("expired");
        return service.getView();
      }
      const current = generation;
      const signal = controller.signal;
      const task = (async () => {
        try {
          const result = enterpriseIdentityPollResultSchema.parse(
            await adapter.poll(attemptId, signal),
          );
          if (current !== generation) return service.getView();
          if (result.status === "authenticated") await commit(result.session, current);
          else if (result.status === "expired") {
            invalidate();
            signedOut("expired");
          }
          return service.getView();
        } catch {
          fail(current);
          throw new Error("企业微信登录失败，请重试或跳过登录");
        }
      })();
      pollTask = task;
      void task
        .finally(() => {
          if (pollTask === task) pollTask = null;
        })
        .catch(() => {});
      return task;
    },
    async cancelLogin(attemptId) {
      if (attemptId !== undefined && attempt?.id !== attemptId) return;
      invalidate();
      if (view.status !== "authenticated") signedOut(adapter ? null : "unconfigured");
      await writes;
    },
    async logout() {
      const previous = session;
      const current = invalidate();
      session = null;
      clearTimeout(expiryTimer);
      signedOut(adapter ? null : "unconfigured");
      await enqueue(() => credentials.delete(SESSION_KEY));
      if (previous && adapter) {
        try {
          await adapter.revoke(previous);
        } catch {
          logger.warn(undefined, "Remote logout failed; local session was cleared");
        }
      }
      if (current === generation) logger.info(undefined, "Enterprise session signed out");
    },
  };
  return service;
}
