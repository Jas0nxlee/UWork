import {
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
}

/** 套餐 API 已退役；本地功能配置不再借道智谱 client/configs。 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const removed = async (): Promise<never> => {
    throw new Error("智谱内置套餐接口已移除，请配置自定义供应商");
  };
  return {
    getStartPlanPreview: async () => null,
    getForceUpdateConfig: async () => null,
    getModelContextBudgetStrategy: async () => DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    getDynamicWorkflowClientConfig: async () =>
      resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env }),
    getOffPeakClientConfig: async () => {
      if (!dependencies.resolveOffPeakModelSelectionView) return removed();
      return {
        enabled: false,
        modelSelectionView: await dependencies.resolveOffPeakModelSelectionView(),
      };
    },
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
