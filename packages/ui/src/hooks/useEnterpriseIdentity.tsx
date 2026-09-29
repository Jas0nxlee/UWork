import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { IEnterpriseIdentityService } from "@zcode/services";
import {
  enterpriseIdentityAttemptSchema,
  enterpriseLoginRequestSchema,
  enterpriseIdentityViewSchema,
  type EnterpriseIdentityView,
  type EnterpriseLoginSurface,
} from "@zcode/shared";
import { useEnterpriseIdentityStore } from "@/store/enterpriseIdentityStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { EnterpriseLoginPage } from "@/login/EnterpriseLoginPage.js";
import { logger } from "@/logger.js";
import { createEnterpriseLoginSurfaceGate } from "./enterpriseLoginSurfaceGate.js";

interface IdentityContextValue {
  view: EnterpriseIdentityView | null;
  allowLogin: boolean;
  openLogin(): void;
  logout(): Promise<void>;
}
const IdentityContext = createContext<IdentityContextValue | null>(null);

/** 固定绑定应用 base services，嵌套远端 ServiceProvider 不会替换身份 owner。 */
export function EnterpriseIdentityProvider({
  service,
  showOnStartup,
  allowLogin = true,
  children,
}: {
  service?: IEnterpriseIdentityService;
  showOnStartup: boolean;
  allowLogin?: boolean;
  children: ReactNode;
}) {
  const platform = usePlatform();
  const owner = service ?? null;
  const view = useEnterpriseIdentityStore((state) => (state.owner === owner ? state.view : null));
  const [open, setOpen] = useState(showOnStartup);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const actionGeneration = useRef(0);
  const nativeAttemptId = useRef<string | null>(null);
  const [surfaceGate] = useState(createEnterpriseLoginSurfaceGate);
  const surfaceController = useRef<AbortController | null>(null);
  const onSurface = useCallback(
    (surface: EnterpriseLoginSurface | null) => {
      surfaceGate.publish(surface);
      if (nativeAttemptId.current)
        platform.updateEnterpriseLogin?.({ id: nativeAttemptId.current, surface });
    },
    [platform, surfaceGate],
  );

  useEffect(() => {
    const store = useEnterpriseIdentityStore.getState();
    store.attach(owner);
    let active = true;
    const apply = (candidate: unknown) => {
      if (!active || !owner) return;
      const parsed = enterpriseIdentityViewSchema.safeParse(candidate);
      if (!parsed.success) {
        setError(true);
        return;
      }
      store.project(owner, parsed.data);
    };
    if (!owner) return;
    // 先订阅，再读取；revision 防止慢快照覆盖更新的认证事件。
    const subscription = owner.onDidChange(apply);
    const restoreGeneration = actionGeneration.current;
    void (allowLogin ? owner.restoreSession() : owner.getView()).then(apply).catch(() => {
      // 跳过或重新发起登录后，旧恢复失败不能污染新登录页的错误状态。
      if (active && actionGeneration.current === restoreGeneration) {
        setError(true);
        logger.warn("Enterprise identity restore failed");
      }
    });
    return () => {
      active = false;
      actionGeneration.current++;
      surfaceController.current?.abort();
      surfaceController.current = null;
      if (nativeAttemptId.current) platform.cancelEnterpriseLogin?.(nativeAttemptId.current);
      nativeAttemptId.current = null;
      subscription.dispose();
    };
  }, [owner, allowLogin, platform]);

  useEffect(() => {
    if (view?.status === "authenticated") {
      setOpen(false);
      setBusy(false);
      setError(false);
    }
    if (view?.status !== "waiting" && surfaceController.current) {
      actionGeneration.current++;
      surfaceController.current.abort();
      surfaceController.current = null;
      if (nativeAttemptId.current) platform.cancelEnterpriseLogin?.(nativeAttemptId.current);
      nativeAttemptId.current = null;
      setBusy(false);
    }
  }, [view?.status, platform]);

  useEffect(() => {
    if (!owner || !allowLogin || view?.status !== "waiting" || view.pending.callbackUrl) return;
    const pollGeneration = actionGeneration.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const candidate = await owner.pollLogin(view.pending.id);
        if (!active) return;
        useEnterpriseIdentityStore
          .getState()
          .project(owner, enterpriseIdentityViewSchema.parse(candidate));
        if (candidate.status === "waiting") timer = setTimeout(() => void poll(), 1500);
      } catch {
        if (active && actionGeneration.current === pollGeneration) {
          setError(true);
          logger.warn("Enterprise identity polling failed");
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [owner, allowLogin, view?.status, view?.pending?.id]);

  const skip = useCallback(() => {
    actionGeneration.current++;
    surfaceController.current?.abort();
    surfaceController.current = null;
    setBusy(false);
    setOpen(false);
    if (nativeAttemptId.current) platform.cancelEnterpriseLogin?.(nativeAttemptId.current);
    nativeAttemptId.current = null;
    if (owner && allowLogin)
      void owner.cancelLogin().catch(() => logger.warn("Enterprise login cancellation failed"));
  }, [owner, allowLogin, platform]);
  const login = useCallback(async () => {
    if (!owner || !allowLogin || busy) return;
    const generation = ++actionGeneration.current;
    surfaceController.current?.abort();
    const controller = new AbortController();
    surfaceController.current = controller;
    setBusy(true);
    setError(false);
    let startedAttemptId: string | null = null;
    try {
      const attempt = enterpriseIdentityAttemptSchema.parse(await owner.beginLogin());
      startedAttemptId = attempt.id;
      if (generation !== actionGeneration.current) return;
      if (attempt.callbackUrl) {
        if (!platform.openEnterpriseLogin)
          throw new Error("Desktop enterprise login is unavailable");
        const surface = await surfaceGate.wait(controller.signal);
        if (generation !== actionGeneration.current) return;
        nativeAttemptId.current = attempt.id;
        const callback = await platform.openEnterpriseLogin(
          enterpriseLoginRequestSchema.parse({ ...attempt, surface }),
        );
        if (generation !== actionGeneration.current) return;
        nativeAttemptId.current = null;
        if (callback === null) await owner.cancelLogin(attempt.id);
        else await owner.completeLogin(attempt.id, callback);
      } else platform.openExternal(attempt.authorizationUrl);
    } catch {
      if (generation === actionGeneration.current) {
        setError(true);
        if (startedAttemptId) {
          // 就绪握手或 native 打开也可能失败；所有已开始的尝试都要取消，不能只清理已经显示的 view。
          platform.cancelEnterpriseLogin?.(startedAttemptId);
          nativeAttemptId.current = null;
          void owner
            .cancelLogin(startedAttemptId)
            .catch(() => logger.warn("Enterprise login cancellation failed"));
        }
        logger.warn("Enterprise login failed");
      }
    } finally {
      if (surfaceController.current === controller) surfaceController.current = null;
      if (generation === actionGeneration.current) setBusy(false);
    }
  }, [owner, allowLogin, platform, busy, surfaceGate]);
  const logout = useCallback(async () => {
    if (!owner || !allowLogin) return;
    actionGeneration.current++;
    try {
      await owner.logout();
    } catch {
      setOpen(true);
      setError(true);
      logger.warn("Enterprise logout failed");
    }
  }, [owner, allowLogin]);

  return (
    <IdentityContext.Provider
      value={{
        view,
        allowLogin,
        openLogin: () => {
          setError(false);
          setOpen(true);
        },
        logout,
      }}
    >
      {children}
      {/* 重新打开只覆盖工作区，不卸载 Root，以免丢失未提交草稿和标签状态。 */}
      {open && allowLogin ? (
        <EnterpriseLoginPage
          configured={view?.configured ?? false}
          waiting={busy || view?.status === "waiting"}
          error={error || view?.error === "failed"}
          expired={view?.error === "expired"}
          onLogin={() => void login()}
          onSkip={skip}
          onSurface={onSurface}
        />
      ) : null}
    </IdentityContext.Provider>
  );
}

export function useEnterpriseIdentity(): IdentityContextValue | null {
  return useContext(IdentityContext);
}
