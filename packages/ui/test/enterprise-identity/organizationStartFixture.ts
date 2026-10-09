import type { EnterpriseIdentityView } from "@zcode/shared";
import type { IEnterpriseIdentityService } from "@zcode/services";

/** 模拟 Host 启动 Promise 复用；测试通过真实 Provider 验证取消屏障。 */
export function installOrganizationStartFixture({
  service,
  readView,
  emit,
  params,
  nativeCallback,
}: {
  service: IEnterpriseIdentityService;
  readView: () => EnterpriseIdentityView;
  emit: (view: EnterpriseIdentityView) => void;
  params: URLSearchParams;
  nativeCallback: string;
}): EnterpriseIdentityView {
  let starting: ReturnType<IEnterpriseIdentityService["beginLogin"]> | null = null;
  let attemptId: string | null = null;
  let starts = 0;
  service.selectOrganization = async (orgId) => {
    emit({ ...readView(), revision: readView().revision + 1, selectedOrgId: orgId });
    return readView();
  };
  service.beginLogin = () => {
    if (starting) return starting;
    const orgId = readView().selectedOrgId!;
    const count = ++starts;
    document.documentElement.dataset.startOrganizations = JSON.stringify([
      ...JSON.parse(document.documentElement.dataset.startOrganizations ?? "[]"),
      orgId,
    ]);
    const task = (async () => {
      if (count === 1)
        await new Promise<void>((resolve, reject) => {
          Object.assign(window, {
            releaseOldStart: () =>
              params.has("old_fail") ? reject(new Error("Fixture start failure")) : resolve(),
          });
        });
      const id = `${orgId}-${count}`;
      attemptId = id;
      const callbackUrl = `${nativeCallback}?uwork_nonce=${id}`;
      const attempt = {
        id,
        expiresAt: Date.now() + 60000,
        callbackUrl,
        expectedState: orgId,
        authorizationUrl: `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=wx-${orgId}&agentid=1000001&state=${orgId}&redirect_uri=${encodeURIComponent(callbackUrl)}`,
      };
      emit({
        ...readView(),
        revision: readView().revision + 1,
        status: "waiting",
        pending: { id, expiresAt: attempt.expiresAt, callbackUrl },
        error: null,
      });
      return attempt;
    })();
    starting = task;
    void task
      .finally(() => {
        if (starting === task) starting = null;
      })
      .catch(() => {});
    return task;
  };
  service.cancelLogin = async (id) => {
    document.documentElement.dataset.cancelledAttempts = JSON.stringify([
      ...JSON.parse(document.documentElement.dataset.cancelledAttempts ?? "[]"),
      id,
    ]);
    if (attemptId !== id) return;
    attemptId = null;
    emit({
      ...readView(),
      revision: readView().revision + 1,
      status: "signed-out",
      pending: null,
      error: null,
    });
  };
  service.pollLogin = async () => readView();
  return {
    ...readView(),
    organizations: [
      { id: "bj", label: "北京" },
      { id: "nj", label: "南京" },
    ],
    selectedOrgId: "bj",
  };
}
