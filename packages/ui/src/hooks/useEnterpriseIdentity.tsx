import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  IEnterpriseIdentityService,
  IProviderSettingsService,
  IUcasGatewayService,
} from "@zcode/services";
import {
  enterpriseIdentityAttemptSchema,
  enterpriseIdentityCompletionSchema,
  enterpriseLoginRequestSchema,
  enterpriseIdentityViewSchema,
  type EnterpriseIdentityView,
  type EnterpriseLoginSurface,
} from "@zcode/shared";
import { useEnterpriseIdentityStore } from "@/store/enterpriseIdentityStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { EnterpriseLoginPage } from "@/login/EnterpriseLoginPage.js";
import { UcasApiKeyDialog } from "@/login/UcasApiKeyDialog.js";
import { hasConfiguredUcasApiKey } from "@/login/ucasApiKeyPrompt.js";
import { logger } from "@/logger.js";
import { createEnterpriseLoginSurfaceGate } from "./enterpriseLoginSurfaceGate.js";

interface IdentityContextValue {
  view: EnterpriseIdentityView | null;
  allowLogin: boolean;
  openLogin(): void;
  logout(): Promise<void>;
  /** 配置里的可选组织（多公司时登录卡片展示选择器）。 */
  organizations: EnterpriseIdentityView["organizations"];
  selectedOrgId: string | null;
  /** 组织展示名（label 优先）；传入的身份组织不在清单内时返回 null。 */
  organizationLabel(orgId: string): string | null;
  selectOrganization(orgId: string): Promise<void>;
}
const IdentityContext = createContext<IdentityContextValue | null>(null);

/** 固定绑定应用 base services，嵌套远端 ServiceProvider 不会替换身份 owner。 */
export function EnterpriseIdentityProvider({
  service,
  providerSettingsService,
  ucasGatewayService,
  showOnStartup,
  allowLogin = true,
  children,
}: {
  service?: IEnterpriseIdentityService;
  providerSettingsService: Pick<IProviderSettingsService, "refresh" | "setUcasApiKeyIfMissing">;
  /** 企业网关自动配置；旧 Host 或只读 attachment 不提供。 */
  ucasGatewayService?: IUcasGatewayService;
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
  const [showUcasApiKeyPrompt, setShowUcasApiKeyPrompt] = useState(false);
  const actionGeneration = useRef(0);
  const nativeAttemptId = useRef<string | null>(null);
  const activeAttemptId = useRef<string | null>(null);
  const gatewaySyncRef = useRef<string | null>(null);
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
      activeAttemptId.current = null;
      setOpen(false);
      setBusy(false);
      setError(false);
    } else {
      setShowUcasApiKeyPrompt(false);
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
    if (!ucasGatewayService || !allowLogin) return;
    if (view?.status !== "authenticated" || !view.profile) {
      gatewaySyncRef.current = null;
      return;
    }
    // 每个已认证身份只自动同步一次；失败后由面板的「同步」按钮显式重试。
    const identityKey = `${view.profile.tenantId}:${view.profile.id}`;
    if (gatewaySyncRef.current === identityKey) return;
    gatewaySyncRef.current = identityKey;
    void ucasGatewayService.sync("startup");
  }, [ucasGatewayService, allowLogin, view?.status, view?.profile?.id, view?.profile?.tenantId]);

  useEffect(() => {
    // 轮询与内嵌扫码并行：企业微信桌面端把回调交给系统浏览器时，窗口内永远等不到
    // 一次性 code，只能靠 Host 的握手轮询认领会话；窗口内回调路径仍由 completeLogin 结算。
    if (!owner || !allowLogin || view?.status !== "waiting") return;
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
    setShowUcasApiKeyPrompt(false);
    surfaceController.current?.abort();
    surfaceController.current = null;
    setBusy(false);
    setOpen(false);
    if (nativeAttemptId.current) platform.cancelEnterpriseLogin?.(nativeAttemptId.current);
    nativeAttemptId.current = null;
    // 跳过只是关闭本窗口入口；无 attempt ID 的取消会中止 Host 正在恢复的设备会话。
    const attemptId = activeAttemptId.current;
    activeAttemptId.current = null;
    if (owner && allowLogin && attemptId)
      void owner
        .cancelLogin(attemptId)
        .catch(() => logger.warn("Enterprise login cancellation failed"));
  }, [owner, allowLogin, platform]);
  /** 二维码阶段返回公司选择：取消本次尝试但保留登录入口（与「跳过」的区别是不关弹窗）。 */
  const backToOrganizations = useCallback(() => {
    actionGeneration.current++;
    setShowUcasApiKeyPrompt(false);
    surfaceController.current?.abort();
    surfaceController.current = null;
    setBusy(false);
    setError(false);
    if (nativeAttemptId.current) platform.cancelEnterpriseLogin?.(nativeAttemptId.current);
    nativeAttemptId.current = null;
    const attemptId = activeAttemptId.current;
    activeAttemptId.current = null;
    if (owner && allowLogin && attemptId)
      void owner
        .cancelLogin(attemptId)
        .catch(() => logger.warn("Enterprise login cancellation failed"));
  }, [owner, allowLogin, platform]);
  const login = useCallback(async () => {
    if (!owner || !allowLogin || busy) return;
    const generation = ++actionGeneration.current;
    setShowUcasApiKeyPrompt(false);
    surfaceController.current?.abort();
    // beginLogin 尚未返回时外部轮询可能已经认证成功；此时不能保留只属于原生扫码的
    // controller，否则认证 effect 会误触发取消并让迟到的 beginLogin 继续取消已完成的登录。
    surfaceController.current = null;
    let controller: AbortController | null = null;
    setBusy(true);
    setError(false);
    let startedAttemptId: string | null = null;
    try {
      const attempt = enterpriseIdentityAttemptSchema.parse(await owner.beginLogin());
      startedAttemptId = attempt.id;
      if (generation !== actionGeneration.current) {
        // beginLogin 可能在跳过后才返回；只取消刚取得的这次尝试。
        void owner
          .cancelLogin(attempt.id)
          .catch(() => logger.warn("Enterprise login cancellation failed"));
        return;
      }
      activeAttemptId.current = attempt.id;
      if (attempt.callbackUrl) {
        if (!platform.openEnterpriseLogin)
          throw new Error("Desktop enterprise login is unavailable");
        controller = new AbortController();
        surfaceController.current = controller;
        const surface = await surfaceGate.wait(controller.signal);
        if (generation !== actionGeneration.current) return;
        nativeAttemptId.current = attempt.id;
        const callback = await platform.openEnterpriseLogin(
          enterpriseLoginRequestSchema.parse({ ...attempt, surface }),
        );
        if (generation !== actionGeneration.current) return;
        nativeAttemptId.current = null;
        if (callback === null) await owner.cancelLogin(attempt.id);
        else {
          // 回调已离开原生扫码视图；先结束 surface 等待，再让 Host 发布认证状态。
          // 否则认证事件会触发下方 effect 误判为扫码取消，使成功后的引导失效。
          surfaceController.current = null;
          const completion = enterpriseIdentityCompletionSchema.parse(
            await owner.completeLogin(attempt.id, callback),
          );
          if (generation === actionGeneration.current) {
            useEnterpriseIdentityStore.getState().project(owner, completion.view);
            if (
              completion.view.status === "authenticated" &&
              completion.committedAttemptId === attempt.id
            ) {
              try {
                // 登录完成后先自动配置网关地址与 API Key；只有拿不到 Key 才回退手工输入。
                const provisioning = ucasGatewayService
                  ? await ucasGatewayService.sync("login")
                  : null;
                const latest = useEnterpriseIdentityStore.getState();
                // 只接受本窗口这次扫码完成后的身份版本；恢复、退出、其它窗口更新及迟到读取无效。
                if (
                  generation === actionGeneration.current &&
                  latest.owner === owner &&
                  latest.view?.status === "authenticated" &&
                  latest.view.revision === completion.view.revision &&
                  provisioning?.providerHasApiKey !== true
                ) {
                  const providerView = await providerSettingsService.refresh("ucas-login-prompt");
                  if (!hasConfiguredUcasApiKey(providerView)) setShowUcasApiKeyPrompt(true);
                }
              } catch {
                // 网关同步或 Provider Settings 刷新失败不影响已完成的企业登录；模型设置仍可单独录入密钥。
                logger.warn("UCAS provisioning after enterprise login failed");
              }
            }
          }
        }
        if (activeAttemptId.current === attempt.id) activeAttemptId.current = null;
      } else {
        // waiting 事件的快速轮询可先于 beginLogin 返回并完成认证；打开授权页前
        // 复核 Host 与本窗口投影，避免已完成的身份再弹出过期浏览器登录页。
        const latest = enterpriseIdentityViewSchema.parse(await owner.getView());
        if (generation !== actionGeneration.current) return;
        const projection = useEnterpriseIdentityStore.getState();
        if (latest.status === "authenticated") projection.project(owner, latest);
        if (
          latest.status === "authenticated" ||
          (projection.owner === owner && projection.view?.status === "authenticated")
        ) {
          if (activeAttemptId.current === attempt.id) activeAttemptId.current = null;
          return;
        }
        platform.openExternal(attempt.authorizationUrl);
      }
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
          if (activeAttemptId.current === startedAttemptId) activeAttemptId.current = null;
        }
        logger.warn("Enterprise login failed");
      }
    } finally {
      if (controller && surfaceController.current === controller) surfaceController.current = null;
      if (generation === actionGeneration.current) setBusy(false);
    }
  }, [owner, allowLogin, platform, busy, surfaceGate, providerSettingsService, ucasGatewayService]);
  const logout = useCallback(async () => {
    if (!owner || !allowLogin) return;
    actionGeneration.current++;
    setShowUcasApiKeyPrompt(false);
    try {
      await owner.logout();
    } catch {
      setOpen(true);
      setError(true);
      logger.warn("Enterprise logout failed");
    }
  }, [owner, allowLogin]);
  const organizations = view?.organizations ?? [];
  const selectedOrgId = view?.selectedOrgId ?? null;
  const organizationLabel = useCallback(
    (orgId: string) => {
      const match = organizations.find((organization) => organization.id === orgId);
      return match ? (match.label ?? match.id) : null;
    },
    [organizations],
  );
  const selectOrganization = useCallback(
    async (orgId: string) => {
      if (!owner) return;
      try {
        // 选择只是设备偏好；授权判断仍由服务端与回包校验决定，这里失败不弹错误页。
        const candidate = enterpriseIdentityViewSchema.parse(await owner.selectOrganization(orgId));
        useEnterpriseIdentityStore.getState().project(owner, candidate);
      } catch {
        logger.warn("Enterprise identity organization selection failed");
      }
    },
    [owner],
  );

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
        organizations,
        selectedOrgId,
        organizationLabel,
        selectOrganization,
      }}
    >
      {children}
      {/* 重新打开只覆盖工作区，不卸载 Root，以免丢失未提交草稿和标签状态。 */}
      {open && allowLogin ? (
        <EnterpriseLoginPage
          configured={owner ? (view?.configured ?? null) : false}
          waiting={busy || view?.status === "waiting"}
          organizations={organizations}
          selectedOrgId={selectedOrgId}
          error={error || view?.error === "failed"}
          expired={view?.error === "expired"}
          onLogin={() => void login()}
          onSelectOrg={(orgId) => void selectOrganization(orgId)}
          onBackToOrganizations={backToOrganizations}
          onSkip={skip}
          onSurface={onSurface}
        />
      ) : null}
      {showUcasApiKeyPrompt && !open && allowLogin && view?.status === "authenticated" ? (
        <UcasApiKeyDialog
          providerSettingsService={providerSettingsService}
          onClose={() => setShowUcasApiKeyPrompt(false)}
        />
      ) : null}
    </IdentityContext.Provider>
  );
}

export function useEnterpriseIdentity(): IdentityContextValue | null {
  return useContext(IdentityContext);
}
