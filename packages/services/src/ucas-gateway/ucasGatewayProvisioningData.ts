import type { UcasGatewayEndpoint, UcasGatewayUsageRequest, UcasGatewayView } from "@zcode/shared";
import type { UcasGatewayClient } from "./ucasGatewayClient.js";

/** 企业账号没有 Key 时生成的别名，沿用服务端长度限制。 */
const GATEWAY_KEY_ALIAS = "UWork";

/**
 * 只使用公网 HTTPS 入口。服务端同时下发 `llm_base_url_internal`（明文 http、仅校园网可达），
 * 需要统一走 TLS 且不把内网地址带进客户端，因此既不探测也不写入 Provider 配置。
 */
const resolveEndpoint = (endpoints: { publicBaseUrl: string }): UcasGatewayEndpoint => ({
  baseUrl: endpoints.publicBaseUrl,
  publicBaseUrl: endpoints.publicBaseUrl,
  internalBaseUrl: null,
  source: "public",
});
const ensureKey = async (
  client: UcasGatewayClient,
): Promise<{ key: UcasGatewayView["key"]; apiKey: string; reused: boolean }> => {
  const keys = await client.listKeys();
  const active = keys.find((item) => item.status === "active") ?? keys[0];
  if (active) {
    const apiKey = await client.revealKey(active.id);
    return { key: active, apiKey, reused: true };
  }
  const generated = await client.generateKey(GATEWAY_KEY_ALIAS);
  return { key: generated.key, apiKey: generated.apiKey, reused: false };
};
const readPlanModels = async (
  client: UcasGatewayClient,
  endpoint: UcasGatewayEndpoint,
  apiKey: string,
): Promise<{ ids: readonly string[]; unrestricted: boolean; hasSubscription: boolean }> => {
  const plan = await client.readPlanModels();
  if (plan.models.length > 0) {
    return {
      ids: plan.models,
      unrestricted: plan.unrestricted,
      hasSubscription: plan.hasSubscription,
    };
  }
  // 套餐不限模型时回退到协议级 `/models`；读取失败不阻断 Key 与端点配置。
  try {
    const ids = await client.listEndpointModels(endpoint.baseUrl, apiKey);
    return { ids, unrestricted: plan.unrestricted, hasSubscription: plan.hasSubscription };
  } catch {
    return { ids: [], unrestricted: plan.unrestricted, hasSubscription: plan.hasSubscription };
  }
};

/** 仅收集 API 数据；身份 admission、本机写入与视图提交由 Gateway Service 唯一持有。 */
export async function readUcasGatewayProvisioningData(
  client: UcasGatewayClient,
  usageRequest: UcasGatewayUsageRequest,
) {
  const keyInfo = await ensureKey(client);
  const endpoint = resolveEndpoint(await client.readGatewayEndpoints());
  const plan = await readPlanModels(client, endpoint, keyInfo.apiKey);
  const subscriptions = [...(await client.readSubscriptions().catch(() => []))];
  const usage = await client.readUsage(usageRequest).catch(() => null);
  return { keyInfo, endpoint, plan, subscriptions, usage };
}
