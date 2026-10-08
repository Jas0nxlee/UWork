import type { EnterpriseIdentityView } from "@zcode/shared";

type ViewPayload = Omit<
  EnterpriseIdentityView,
  "revision" | "configured" | "organizations" | "selectedOrgId"
>;

/**
 * 视图投影：`revision` 单调递增，组织清单与选中组织由每次发布时合并进来，
 * 避免流程编排里每个发布点各自拼这些派生字段。
 */
export interface EnterpriseIdentityViewPublisher {
  current(): EnterpriseIdentityView;
  publish(next: ViewPayload): void;
  signedOut(error?: EnterpriseIdentityView["error"]): void;
  /** 身份不变、只换组织选择时按当前状态重发一次。 */
  republish(): void;
}

export function createEnterpriseIdentityViewPublisher(options: {
  emit: (view: EnterpriseIdentityView) => void;
  isConfigured: () => boolean;
  organizations: () => EnterpriseIdentityView["organizations"];
  selectedOrgId: () => string | null;
  initialError: EnterpriseIdentityView["error"];
}): EnterpriseIdentityViewPublisher {
  let view: EnterpriseIdentityView = {
    revision: 0,
    configured: options.isConfigured(),
    status: "signed-out",
    profile: null,
    pending: null,
    error: options.initialError,
    organizations: [],
    selectedOrgId: null,
  };
  const publish = (next: ViewPayload) => {
    view = {
      ...next,
      revision: view.revision + 1,
      configured: options.isConfigured(),
      organizations: options.organizations(),
      selectedOrgId: options.selectedOrgId(),
    } as EnterpriseIdentityView;
    options.emit(structuredClone(view));
  };
  return {
    current: () => view,
    publish,
    signedOut: (error = null) =>
      publish({ status: "signed-out", profile: null, pending: null, error }),
    republish: () => {
      if (view.status === "authenticated") {
        publish({
          status: "authenticated",
          profile: view.profile,
          pending: null,
          error: view.error,
        });
        return;
      }
      if (view.status === "waiting") {
        publish({ status: "waiting", profile: null, pending: view.pending, error: view.error });
        return;
      }
      publish({ status: "signed-out", profile: null, pending: null, error: view.error });
    },
  };
}
