import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  type ApiClient,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import { BigModelCodingPlanSubscriptionProvider } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import { createCodingPlanSubscriptionService } from "../src/coding-plan-subscription/codingPlanSubscriptionService.js";

// 动态工作流灰度快照的 Host 侧读取（docs/dynamic-workflow/launch.md「Gray release」）：
// 复用 client/configs 通道，本地覆盖短路远端，失败 fail-closed 且不抛给调用方。

function createConfigsResponse(dynamicWorkflow: unknown): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      msg: "",
      data: { configs: dynamicWorkflow === undefined ? {} : { dynamicWorkflow } },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function createProvider(apiClient: ApiClient) {
  return new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: { load: vi.fn() },
  });
}

describe("getDynamicWorkflowClientConfig", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("本地覆盖命中时直接返回，不打远端（无 TTL、无首次 Host 竞态）", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "alwaysOn");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("override must not request remote client config");
      }),
    };
    const provider = createProvider(apiClient);

    await expect(provider.getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "override",
      offeredMode: "alwaysOn",
    });
    await expect(
      provider.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ source: "override" });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("覆盖值非法时忽略覆盖，仍读远端", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "on");
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse({ mode: "onDemand" })),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "onDemand",
      enabled: true,
      source: "remote",
      offeredMode: "onDemand",
    });
    expect(apiClient.request).toHaveBeenCalledTimes(1);
  });

  it("远端下发合法 mode 时按远端裁决", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse({ mode: "alwaysOn" })),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
      offeredMode: "alwaysOn",
    });
  });

  it("远端成功但没有该 key 时视为关闭", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse(undefined)),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "default",
      offeredMode: "disabled",
    });
  });

  it("命中 1h 快照缓存，forceRefresh 绕过并看到新值", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(createConfigsResponse({ mode: "disabled" }))
        .mockResolvedValueOnce(createConfigsResponse({ mode: "alwaysOn" })),
    };
    const provider = createProvider(apiClient);

    await expect(provider.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
    });
    await expect(provider.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
    });
    expect(apiClient.request).toHaveBeenCalledTimes(1);

    await expect(
      provider.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ mode: "alwaysOn", enabled: true, source: "remote" });
    expect(apiClient.request).toHaveBeenCalledTimes(2);
  });

  it("远端请求失败时 fail-closed 返回 default，不抛给调用方", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "default",
      offeredMode: "disabled",
    });
  });

  it("请求失败但本地有覆盖时仍返回覆盖（覆盖先于任何网络动作）", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "disabled");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "override",
      offeredMode: "disabled",
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("UWork service 默认配置与 forceRefresh 都不查询远端", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("UCAS initialization must not request remote client config");
      }),
    };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    await expect(service.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
      source: "default",
    });
    await expect(
      service.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ enabled: false, source: "default" });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("UWork service 不等待永不完成的远端请求", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "");
    const apiClient: ApiClient = {
      request: vi.fn(() => new Promise<Response>(() => {})),
    };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    const config = service.getDynamicWorkflowClientConfig();
    expect(apiClient.request).not.toHaveBeenCalled();
    await expect(config).resolves.toMatchObject({ enabled: false, source: "default" });
  });

  it("UWork service 保留本地 offer 且每次读取最新用户选择", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "alwaysOn");
    let userMode: DynamicWorkflowMode | undefined = "disabled";
    const credentials = { load: vi.fn() };
    const apiClient: ApiClient = { request: vi.fn() };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: credentials,
      resolveDynamicWorkflowUserMode: async () => userMode,
    });

    await expect(service.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      offeredMode: "alwaysOn",
      mode: "disabled",
      userMode: "disabled",
      source: "override",
    });
    userMode = "onDemand";
    await expect(service.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      offeredMode: "alwaysOn",
      mode: "onDemand",
      userMode: "onDemand",
    });
    userMode = undefined;
    await expect(service.getDynamicWorkflowClientConfig()).resolves.toEqual({
      offeredMode: "alwaysOn",
      mode: "alwaysOn",
      enabled: true,
      source: "override",
    });
    expect(apiClient.request).not.toHaveBeenCalled();
    expect(credentials.load).not.toHaveBeenCalled();
  });
});
