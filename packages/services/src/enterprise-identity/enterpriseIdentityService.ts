/* eslint-disable max-lines -- 身份是单写者状态机：generation/invalidate 的次序保证（迟到回调不得复活身份）在同一处才看得清；视图投影与组织选择已抽到 enterpriseIdentityViewPublisher / enterpriseIdentityOrganizations。 */
import { Emitter } from "@zcode/rpc";
import {
  enterpriseIdentityAttemptSchema,
  enterpriseIdentityPollResultSchema,
  enterpriseIdentitySessionSchema,
  readEnterpriseIdentityCallback,
  type EnterpriseIdentityAttempt,
  type EnterpriseIdentityCompletion,
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
import type { IdentityOrganizationStore } from "./identityOrganizationStore.js";
import { createEnterpriseIdentityOrganizationSelection } from "./enterpriseIdentityOrganizations.js";
import { createEnterpriseIdentityViewPublisher } from "./enterpriseIdentityViewPublisher.js";
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
  /** 本机记住的登录组织（设备偏好）；缺省时不记忆。 */
  organizationStore?: IdentityOrganizationStore;
  broadcast?: Pick<IBroadcastService, "send" | "onMessage">;
  now?: () => number;
}): IEnterpriseIdentityService {
  let adapter = options.adapter;
  const store = options.sessionStore ?? createLocalIdentitySessionStore(options.credentials);
  const now = options.now ?? Date.now;
  const changed = new Emitter<EnterpriseIdentityView>();
  const organizations = createEnterpriseIdentityOrganizationSelection({
    // 兼容未实现多组织的适配器（旧 Host / Web 注入）：视为「无清单」，行为与单组织一致。
    listOrganizations: () => adapter?.listOrganizations?.() ?? [],
    resolveOrganization: (orgId) => adapter?.resolveOrganization?.(orgId),
    persist: (orgId) =>
      enqueue(async () => {
        await options.organizationStore?.write(orgId);
      }),
    ...(options.organizationStore ? { store: options.organizationStore } : {}),
  });
  const publisher = createEnterpriseIdentityViewPublisher({
    emit: (next) => changed.fire(next),
    isConfigured: () => Boolean(adapter),
    organizations: () => organizations.options(),
    selectedOrgId: () => organizations.current(),
    initialError: adapter ? null : "unconfigured",
  });
  const publish = publisher.publish;
  const signedOut = publisher.signedOut;
  let generation = 0;
  let knownRevision = 0;
  let attemptRevision = 0;
  let controller = new AbortController();
  let session: EnterpriseIdentitySession | null = null;
  let attempt: EnterpriseIdentityAttempt | null = null;
  /** 本次尝试所属组织：兑换 code 时与服务端回包一起校验，不跟着选择后续漂移。 */
  let attemptOrgId: string | null = null;
  let nativeAttemptClaimed = false;
  let startTask: Promise<EnterpriseIdentityAttempt> | null = null;
  let resultTask: Promise<EnterpriseIdentityCompletion> | null = null;
  let restoreTask: Promise<EnterpriseIdentityView> | null = null;
  let adapterTask: Promise<void> | null = null;
  let selectionTask: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

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
    attemptOrgId = null;
    nativeAttemptClaimed = false;
    startTask = null;
    resultTask = null;
    restoreTask = null;
    return generation;
  };
  const ensureAdapter = async () => {
    if (disposed) return;
    if (!adapter && options.loadAdapter) {
      adapterTask ??= options.loadAdapter().then((loaded) => {
        adapter = loaded;
      });
      await adapterTask;
    }
    if (disposed) return;
    // 所有并发调用等待同一次水合；迟到初始化不能覆盖新 generation 或已关闭服务。
    selectionTask ??= (async () => {
      const current = generation;
      await organizations.hydrate();
      if (!disposed && current === generation) signedOut(adapter ? null : "unconfigured");
    })();
    await selectionTask;
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
    if (disposed || !adapter || current !== generation) return structuredClone(publisher.current());
    const record = await store.read();
    if (current !== generation) return structuredClone(publisher.current());
    knownRevision = record.revision;
    if (!record.session) {
      session = null;
      signedOut();
      return structuredClone(publisher.current());
    }
    // 本地到期时间只是调度提示；issuer 的 refresh 才能判定旧 Token 是否还能续期。
    const restored = await adapter.restore(record.session, controller.signal);
    if (current !== generation) return structuredClone(publisher.current());
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
    return structuredClone(publisher.current());
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
    return structuredClone(publisher.current());
  };
  const completeResult = (
    current: number,
    committedAttemptId: string | null,
    operation: () => Promise<EnterpriseIdentitySession | null>,
  ): Promise<EnterpriseIdentityCompletion> => {
    if (resultTask) return resultTask;
    const task = (async () => {
      try {
        const result = await operation();
        if (current !== generation) return { view: await getView(), committedAttemptId: null };
        const committed = result ? await commit(result, current) : false;
        if (result && !committed) await restoreOwned(current);
        const latest = await getView();
        const accepted = committed && current === generation && latest.status === "authenticated";
        return { view: latest, committedAttemptId: accepted ? committedAttemptId : null };
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
      if (publisher.current().status === "authenticated") return getView();
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
    async selectOrganization(orgId) {
      await ensureAdapter();
      if (disposed) throw new Error("企业身份服务已关闭");
      await organizations.select(orgId);
      publisher.republish();
      return getView();
    },
    beginLogin() {
      if (disposed) return Promise.reject(new Error("企业身份服务已关闭"));
      if (startTask) return startTask;
      if (attempt && (!nativeAttemptClaimed || resultTask) && attempt.expiresAt > now())
        return Promise.resolve(structuredClone(attempt));
      if (publisher.current().status === "authenticated")
        return Promise.reject(new Error("请先退出当前企业账号"));
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
          const response = await adapter.start(
            controller.signal,
            organizations.current() ?? undefined,
          );
          const started = enterpriseIdentityAttemptSchema.parse(response);
          if (current !== generation || started.expiresAt <= now())
            throw new Error("企业登录已取消或过期");
          attempt = started;
          attemptOrgId = started.expectedState ?? organizations.current();
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
      return completeResult(current, null, async () => {
        const polled = await adapter!.poll!(attemptId, controller.signal);
        const result = enterpriseIdentityPollResultSchema.parse(polled);
        if (current !== generation) return null;
        if (result.status === "expired") {
          invalidate();
          signedOut("expired");
          return null;
        }
        return result.status === "authenticated" ? result.session : null;
      }).then((result) => result.view);
    },
    completeLogin(attemptId, callbackUrl) {
      const currentView = async () => ({ view: await getView(), committedAttemptId: null });
      if (!adapter?.complete || !attempt || attempt.id !== attemptId) return currentView();
      if (attempt.expiresAt <= now()) {
        invalidate();
        signedOut("expired");
        return currentView();
      }
      let code: string;
      try {
        code = readEnterpriseIdentityCallback(attempt, callbackUrl);
      } catch {
        return Promise.reject(new Error("企业登录回调校验失败"));
      }
      // 领取一次性授权码后保留 attempt 身份用于取消，但即使 CAS 拒绝也不能重复兑换。
      if (nativeAttemptClaimed) return resultTask ?? currentView();
      nativeAttemptClaimed = true;
      const redeem = () =>
        adapter!.complete!(
          code,
          controller.signal,
          attemptOrgId ?? organizations.current() ?? undefined,
        );
      return completeResult(generation, attemptId, redeem);
    },
    async cancelLogin(attemptId) {
      // 缺失/过时 ID 绝不能中断共享 restore controller；仅当前尝试可被取消。
      if (!attemptId || attempt?.id !== attemptId) return;
      invalidate();
      if (publisher.current().status !== "authenticated")
        signedOut(adapter ? null : "unconfigured");
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
