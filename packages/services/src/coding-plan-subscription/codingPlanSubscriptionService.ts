import {
  applyDynamicWorkflowUserMode,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  resolveDynamicWorkflowClientConfig,
  type ApiClient,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  /** 本机设置 owner 每次提供当前选择；远端 Host 未注入时只返回本地 offer。 */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
}

/** UWork 的套餐兼容边界：本地功能配置不借道已退役的智谱账号或 client/configs。 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const removed = async (): Promise<never> => {
    throw new Error("智谱内置套餐接口已移除，请配置自定义供应商");
  };
  return {
    getStartPlanPreview: async () => null,
    getForceUpdateConfig: async () => null,
    getBillingDiscount: async () => undefined,
    getRequestVerificationConfig: async () => null,
    getModelContextBudgetStrategy: async () => DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    getDynamicWorkflowClientConfig: async () => {
      // 上游远端配置读取位于 Agent 就绪链，会让独立 UCAS 初始化等待外部请求超时。
      // 保留本地 offer 和新用户选择接口，shared 规则负责派生视图，不恢复套餐网络依赖。
      const offer = resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env });
      const resolveUserMode = dependencies.resolveDynamicWorkflowUserMode;
      return resolveUserMode ? applyDynamicWorkflowUserMode(offer, await resolveUserMode()) : offer;
    },
    getOffPeakClientConfig: async () => {
      if (!dependencies.resolveOffPeakModelSelectionView) return removed();
      return {
        enabled: false,
        modelSelectionView: await dependencies.resolveOffPeakModelSelectionView(),
      };
    },
    getManualClaimPlanPreviews: removed,
    claimManualPlan: removed,
    batchPreview: removed,
    getStaticProducts: removed,
    getStaticTeamProducts: removed,
    productInfo: removed,
    preview: removed,
    createSign: removed,
    updateSign: removed,
    checkPayment: removed,
    checkPendingOrders: removed,
    queryStripeCards: removed,
    bindStripeCard: removed,
    unbindStripeCard: removed,
    payStripe: removed,
    checkPaypalSupport: removed,
    createPaypalSetupToken: removed,
    subscribePaypal: removed,
    getEnterprisePricing: removed,
    getEnterpriseBalance: removed,
    calculateEnterpriseOrder: removed,
    createEnterpriseOrder: removed,
    getEnterprisePendingOrders: removed,
    cancelEnterpriseOrder: removed,
    continueEnterpriseOrderPayment: removed,
    checkEnterpriseOrderStatus: removed,
  };
}
