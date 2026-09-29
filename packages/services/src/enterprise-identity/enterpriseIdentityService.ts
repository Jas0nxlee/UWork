import { Emitter } from "@zcode/rpc";
import {
  enterpriseIdentityAttemptSchema,
  enterpriseIdentityPollResultSchema,
  enterpriseIdentitySessionSchema,
  readEnterpriseIdentityCallback,
  type EnterpriseIdentityAttempt,
  type EnterpriseIdentitySession,
  type EnterpriseIdentityView,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createLocalIdentitySessionStore,
  type IdentitySessionRecord,
  type IdentitySessionStore,
} from "./identitySessionStore.js";
import type { EnterpriseIdentityAdapter, IEnterpriseIdentityService } from "./contract.js";
import {
  registerIdentityServiceDisposer,
  releaseIdentityOperation,
} from "./identityServiceLifecycle.js";
import { subscribeIdentityPeerChanges } from "./identityPeerSubscription.js";
export { disposeEnterpriseIdentityService } from "./identityServiceLifecycle.js";

const SYNC_CHANNEL = "state:enterprise-identity";
const logger = createServiceLogger("enterprise-identity");

export function createEnterpriseIdentityService(options: {
  credentials: ICredentialService;
  adapter?: EnterpriseIdentityAdapter;
  loadAdapter?: () => Promise<EnterpriseIdentityAdapter | undefined>;
  sessionStore?: IdentitySessionStore;
  broadcast?: Pick<IBroadcastService, "send" | "onMessage">;
  now?: () => number;
}): IEnterpriseIdentityService {
  let adapter = options.adapter;
  const store = options.sessionStore ?? createLocalIdentitySessionStore(options.credentials);
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
  let knownRevision = 0;
  let attemptRevision = 0;
  let controller = new AbortController();
  let session: EnterpriseIdentitySession | null = null;
  let attempt: EnterpriseIdentityAttempt | null = null;
  let nativeAttemptClaimed = false;
  let startTask: Promise<EnterpriseIdentityAttempt> | null = null;
  let resultTask: Promise<EnterpriseIdentityView> | null = null;
  let restoreTask: Promise<EnterpriseIdentityView> | null = null;
  let adapterTask: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

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
    nativeAttemptClaimed = false;
    startTask = null;
    resultTask = null;
    restoreTask = null;
    return generation;
  };
  const ensureAdapter = async () => {
    if (disposed) return;
    if (adapter || !options.loadAdapter) return;
    adapterTask ??= options.loadAdapter().then((loaded) => {
      adapter = loaded;
      signedOut(loaded ? null : "unconfigured");
    });
    await adapterTask;
  };
  const broadcast = async () => {
    try {
      await options.broadcast?.send({
        channel: SYNC_CHANNEL,
        payload: { revision: knownRevision },
      });
    } catch {
      logger.warn(undefined, "Enterprise identity broadcast failed");
    }
  };
  const fail = (current: number) => {
    if (current !== generation) return;
    attempt = null;
    session = null;
    clearTimeout(expiryTimer);
    signedOut("failed");
    logger.warn(undefined, "Enterprise authentication failed");
  };
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    if (!session) return;
    expiryTimer = setTimeout(
      () => {
        void expireSession()
          .then(scheduleExpiry)
          .catch(() => logger.warn(undefined, "Expired session cleanup failed"));
      },
      Math.min(Math.max(1, session.expiresAt - now()), 2147483647),
    );
    expiryTimer.unref();
  };
  const commit = async (
    value: EnterpriseIdentitySession,
    current: number,
    renewal?: IdentitySessionRecord,
  ): Promise<boolean> => {
    if (disposed) return false;
    const validated = enterpriseIdentitySessionSchema.parse(value);
    if (validated.expiresAt <= now()) throw new Error("企业登录会话已过期");
    return enqueue(async () => {
      if (current !== generation) return false;
      const result = renewal
        ? await store.renew(validated, renewal, () => current === generation)
        : await store.write(validated, attemptRevision, () => current === generation);
      if (current !== generation) return false;
      // 同一账号的另一窗口可能已完成续期；共享版本和身份未变时采用库中的新 Token，避免续期回环。
      const sameRenewal =
        renewal &&
        result.record.revision === renewal.revision &&
        result.record.session?.profile.id === validated.profile.id &&
        result.record.session.profile.tenantId === validated.profile.tenantId;
      if (!result.accepted && !sameRenewal) {
        signedOut();
        return false;
      }
      const accepted = result.record.session;
      if (!accepted || accepted.expiresAt <= now()) {
        signedOut("expired");
        return false;
      }
      knownRevision = result.record.revision;
      session = accepted;
      attempt = null;
      scheduleExpiry();
      publish({ status: "authenticated", profile: accepted.profile, pending: null, error: null });
      if (!renewal && result.accepted) await broadcast();
      logger.info(undefined, "Enterprise session authenticated");
      return true;
    });
  };
  const restoreOwned = async (current: number): Promise<EnterpriseIdentityView> => {
    await ensureAdapter();
    if (disposed || !adapter || current !== generation) return structuredClone(view);
    const record = await store.read();
    if (current !== generation) return structuredClone(view);
    knownRevision = record.revision;
    if (!record.session) {
      session = null;
      signedOut();
      return structuredClone(view);
    }
    const restored =
      record.session.expiresAt > now()
        ? await adapter.restore(record.session, controller.signal)
        : null;
    if (current !== generation) return structuredClone(view);
    if (restored) await commit(restored, current, record);
    else
      await enqueue(async () => {
        const result = await store.write(
          null,
          record.revision,
          () => current === generation,
          record.session!.token,
        );
        if (current !== generation) return;
        if (result.accepted) {
          knownRevision = result.record.revision;
          session = null;
          signedOut("expired");
          await broadcast();
        }
      });
    return structuredClone(view);
  };
  const expireSession = async () => {
    if (disposed) return;
    if (!session || session.expiresAt > now()) return;
    const previous = session;
    const current = invalidate();
    session = null;
    signedOut("expired");
    const result = await enqueue(() =>
      store.write(null, knownRevision, () => current === generation, previous.token),
    );
    if (current !== generation) return;
    if (result.accepted) {
      knownRevision = result.record.revision;
      await broadcast();
    } else if (result.record.session) await restoreOwned(current);
  };
  const getView = async () => {
    if (!disposed) {
      await ensureAdapter();
      await expireSession();
    }
    return structuredClone(view);
  };
  const completeResult = (
    current: number,
    operation: () => Promise<EnterpriseIdentitySession | null>,
  ): Promise<EnterpriseIdentityView> => {
    if (resultTask) return resultTask;
    const task = (async () => {
      try {
        const result = await operation();
        if (current !== generation) return getView();
        if (result && !(await commit(result, current))) await restoreOwned(current);
        return getView();
      } catch {
        fail(current);
        throw new Error("企业微信登录失败，请重试或跳过登录");
      }
    })();
    resultTask = task;
    return releaseIdentityOperation(task, () => {
      if (resultTask === task) resultTask = null;
    });
  };
  const service: IEnterpriseIdentityService = {
    onDidChange: changed.event,
    getView,
    restoreSession() {
      if (disposed) return getView();
      if (restoreTask) return restoreTask;
      if (view.status === "authenticated") return getView();
      const current = generation;
      const task = restoreOwned(current).catch(() => {
        fail(current);
        throw new Error("企业登录状态恢复失败，请重试或跳过登录");
      });
      restoreTask = task;
      return releaseIdentityOperation(task, () => {
        if (restoreTask === task) restoreTask = null;
      });
    },
    beginLogin() {
      if (disposed) return Promise.reject(new Error("企业身份服务已关闭"));
      if (startTask) return startTask;
      if (attempt && (!nativeAttemptClaimed || resultTask) && attempt.expiresAt > now())
        return Promise.resolve(structuredClone(attempt));
      if (view.status === "authenticated") return Promise.reject(new Error("请先退出当前企业账号"));
      const current = invalidate();
      const task = (async () => {
        await ensureAdapter();
        if (!adapter) throw new Error("企业微信登录暂未配置");
        try {
          await writes;
          const record = await store.read();
          if (current !== generation) throw new Error("企业登录已取消");
          attemptRevision = record.revision;
          knownRevision = record.revision;
          const started = enterpriseIdentityAttemptSchema.parse(
            await adapter.start(controller.signal),
          );
          if (current !== generation || started.expiresAt <= now())
            throw new Error("企业登录已取消或过期");
          attempt = started;
          publish({
            status: "waiting",
            profile: null,
            pending: {
              id: started.id,
              expiresAt: started.expiresAt,
              ...(started.callbackUrl ? { callbackUrl: started.callbackUrl } : {}),
            },
            error: null,
          });
          return structuredClone(started);
        } catch {
          fail(current);
          throw new Error("企业微信登录失败，请重试或跳过登录");
        }
      })();
      startTask = task;
      return releaseIdentityOperation(task, () => {
        if (startTask === task) startTask = null;
      });
    },
    pollLogin(attemptId) {
      if (!adapter?.poll || !attempt || attempt.id !== attemptId) return getView();
      if (attempt.expiresAt <= now()) {
        invalidate();
        signedOut("expired");
        return getView();
      }
      const current = generation;
      const signal = controller.signal;
      return completeResult(current, async () => {
        const result = enterpriseIdentityPollResultSchema.parse(
          await adapter!.poll!(attemptId, signal),
        );
        if (current !== generation) return null;
        if (result.status === "expired") {
          invalidate();
          signedOut("expired");
          return null;
        }
        return result.status === "authenticated" ? result.session : null;
      });
    },
    completeLogin(attemptId, callbackUrl) {
      if (!adapter?.complete || !attempt || attempt.id !== attemptId) return getView();
      if (attempt.expiresAt <= now()) {
        invalidate();
        signedOut("expired");
        return getView();
      }
      let code: string;
      try {
        code = readEnterpriseIdentityCallback(attempt, callbackUrl);
      } catch {
        return Promise.reject(new Error("企业登录回调校验失败"));
      }
      // 领取一次性授权码后保留 attempt 身份用于取消，但即使 CAS 拒绝也不能重复兑换。
      if (nativeAttemptClaimed) return resultTask ?? getView();
      nativeAttemptClaimed = true;
      const signal = controller.signal;
      return completeResult(generation, () => adapter!.complete!(code, signal));
    },
    async cancelLogin(attemptId) {
      if (attemptId !== undefined && attempt?.id !== attemptId) return;
      invalidate();
      if (view.status !== "authenticated") signedOut(adapter ? null : "unconfigured");
      await writes;
    },
    async logout() {
      if (disposed) return;
      const previous = session;
      invalidate();
      session = null;
      clearTimeout(expiryTimer);
      signedOut(adapter ? null : "unconfigured");
      // 退出是已接受的设备级命令，先持久化 tombstone；后续新尝试必须在该版本上 admission。
      const result = await enqueue(() => store.write(null, undefined, () => true));
      knownRevision = result.record.revision;
      await broadcast();
      if (previous && adapter?.revoke) {
        try {
          await adapter.revoke(previous);
        } catch {
          logger.warn(undefined, "Remote logout failed; local session was cleared");
        }
      }
      logger.info(undefined, "Enterprise session signed out");
    },
  };
  const peerSubscription = subscribeIdentityPeerChanges({
    broadcast: options.broadcast,
    isDisposed: () => disposed,
    readRevision: async () => (await store.read()).revision,
    knownRevision: () => knownRevision,
    synchronize: async () => {
      const current = invalidate();
      session = null;
      clearTimeout(expiryTimer);
      signedOut();
      try {
        await restoreOwned(current);
      } catch {
        fail(current);
      }
    },
    onFailure: () => logger.warn(undefined, "Enterprise peer synchronization failed"),
  });
  registerIdentityServiceDisposer(service, async () => {
    disposed = true;
    invalidate();
    peerSubscription?.dispose();
    clearTimeout(expiryTimer);
    session = null;
    signedOut();
    changed.dispose();
    await writes;
  });
  return service;
}
