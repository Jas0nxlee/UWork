// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ModelProviderSectionLayout } from "@/settings/model-provider-section/SectionLayout.js";
import type { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import type { ProviderTemplatePicker } from "@/settings/model-provider-section/ProviderTemplatePicker.js";

type LayoutProps = ComponentProps<typeof ModelProviderSectionLayout>;
type CardProps = ComponentProps<typeof InlineEditableProviderCard>;
type PickerProps = ComponentProps<typeof ProviderTemplatePicker>;

function personal(providerId: string): ProviderSettingsFormProvider {
  return {
    providerId,
    providerName: providerId,
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: {},
    config: {
      group: "standard-personal",
      api: { type: "openai-chat-completions", baseUrl: "https://models.example.test/v1" },
      access: { type: "api-key", apiKey: "test-key" },
    },
    models: [],
  };
}

const refreshMock = vi.fn(async () => {});
const saveProviderMock = vi.fn(async (_provider: ProviderSettingsFormProvider) => []);
const deleteProviderMock = vi.fn(async (_providerId: string) => {});
const addPersonalModelMock = vi.fn(
  async (
    _providerId: string,
    _modelId: string,
    _config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
  ) => ({}),
);
const createPersonalProviderMock = vi.fn(async () => personal("created-provider"));
const requestLoginEntryMock = vi.fn();
const startOAuthMock = vi.fn();
const logoutMock = vi.fn();
const credentialLoadMock = vi.fn();
const updateSharedSettingsMock = vi.fn();
const openExternalMock = vi.fn();
const confirmMock = vi.fn(async () => true);
let providers: ProviderSettingsFormProvider[] = [];
let layoutProps: LayoutProps | null = null;
let cardProps: CardProps | null = null;
let pickerProps: PickerProps | null = null;

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "zh-CN",
  }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirmMock }));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openExternal: openExternalMock }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {}, loading: false, update: updateSharedSettingsMock }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    oauthService: { startOAuth: startOAuthMock, logout: logoutMock },
    credentialService: { load: credentialLoadMock },
    settingService: { update: updateSharedSettingsMock },
  }),
  useOptionalServices: () => null,
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (
    selector: (state: { requestLoginEntry: typeof requestLoginEntryMock }) => unknown,
  ) => selector({ requestLoginEntry: requestLoginEntryMock }),
}));
vi.mock("@/hooks/useModelProviders.js", () => ({
  useModelProviders: () => ({
    modelProviders: providers,
    providerTemplates: [],
    providerSettingsView: { revision: 73 },
    displayOrder: null,
    loading: false,
    refreshing: false,
    refresh: refreshMock,
    saveProvider: saveProviderMock,
    createPersonalProvider: createPersonalProviderMock,
    deleteProvider: deleteProviderMock,
    addPersonalModel: addPersonalModelMock,
  }),
}));
vi.mock("@/settings/model-provider-section/SectionLayout.js", () => ({
  ModelProviderSectionLayout: (props: LayoutProps) => {
    layoutProps = props;
    return createElement("div", null, props.children as ReactNode);
  },
}));
vi.mock("@/settings/model-provider-section/InlineEditableProviderCard.js", () => ({
  InlineEditableProviderCard: (props: CardProps) => {
    cardProps = props;
    return createElement("div", { "data-testid": "personal-provider" });
  },
}));
vi.mock("@/settings/model-provider-section/ProviderTemplatePicker.js", () => ({
  ProviderTemplatePicker: (props: PickerProps) => {
    pickerProps = props;
    return createElement("div", { "data-testid": "provider-picker" });
  },
}));

function layout(): LayoutProps {
  expect(layoutProps).not.toBeNull();
  return layoutProps!;
}
function card(): CardProps {
  expect(cardProps).not.toBeNull();
  return cardProps!;
}
function expectNoAccountActions() {
  for (const mock of [
    requestLoginEntryMock,
    startOAuthMock,
    logoutMock,
    credentialLoadMock,
    updateSharedSettingsMock,
    openExternalMock,
  ])
    expect(mock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  providers = [personal("custom-provider")];
  layoutProps = null;
  cardProps = null;
  pickerProps = null;
});
afterEach(cleanup);

describe("ModelProviderSection local provider actions after subscription retirement", () => {
  it("打开页面和刷新只读取个人配置，不恢复旧账号", async () => {
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    const mounted = render(createElement(ModelProviderSection));
    mounted.rerender(createElement(ModelProviderSection));
    await act(async () => {
      layout().onRefresh();
    });
    expect(refreshMock).toHaveBeenCalledExactlyOnceWith();
    expect(layout().navigationGroups.map((group) => group.id)).toEqual(["custom"]);
    expect(card().settingsRevision).toBe(73);
    expectNoAccountActions();
  });

  it.each(["bigmodel", "zai"] as const)("保存手动配置的 %s 地址不改变账号域", async (family) => {
    const base = personal(`manual-${family}`);
    const provider = {
      ...base,
      enabled: false,
      executable: false,
      config: {
        ...base.config,
        api: {
          type: "openai-chat-completions" as const,
          baseUrl:
            family === "zai" ? "https://api.z.ai/v1" : "https://open.bigmodel.cn/api/paas/v4",
        },
      },
    };
    providers = [provider];
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(createElement(ModelProviderSection));
    await act(async () => {
      await card().onSave(provider);
    });
    expect(saveProviderMock).toHaveBeenCalledExactlyOnceWith(provider);
    expectNoAccountActions();
  });

  it.each(["bigmodel", "zai"] as const)("选择 %s 个人供应商只更新本页选中项", async (family) => {
    const selected = personal(`manual-${family}`);
    providers = [personal("first-provider"), selected];
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(createElement(ModelProviderSection));
    const item = layout().navigationGroups[0]!.items.find(
      (entry) => entry.type === "custom" && entry.provider.providerId === selected.providerId,
    );
    expect(item).toBeDefined();
    act(() => layout().onSelectNavItem(item!));
    expect(card().provider).toBe(selected);
    expectNoAccountActions();
  });

  it("个人编辑卡不再暴露登录、解绑和购买完成回调", async () => {
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(createElement(ModelProviderSection));
    for (const key of [
      "onCodingPlanLogin",
      "onCodingPlanDisconnect",
      "onCodingPlanPurchaseComplete",
    ])
      expect(card()).not.toHaveProperty(key);
    expect(card().onSave).toBeTypeOf("function");
    expectNoAccountActions();
  });

  it("历史账号组不进入导航，用户个人供应商保持可编辑", async () => {
    providers = [
      personal("custom-provider"),
      { ...personal("retired-zai"), config: { group: "zai-family" } },
      { ...personal("retired-bigmodel"), config: { group: "bigmodel-family" } },
    ];
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(createElement(ModelProviderSection));
    expect(
      layout().navigationGroups.flatMap((group) => group.items.map((item) => item.label)),
    ).toEqual(["custom-provider"]);
    expect(card().provider.providerId).toBe("custom-provider");
    expectNoAccountActions();
  });

  it("UCAS 仅允许密钥和模型编辑，不提供改名、改地址或删除入口", async () => {
    providers = [personal("ucas")];
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(createElement(ModelProviderSection));
    expect(card()).toMatchObject({
      readOnlyEndpoints: true,
      nameEditable: false,
      settingsRevision: 73,
    });
    expect(card().onDelete).toBeUndefined();
    expect(card().onSave).toBeTypeOf("function");
    expect(card().onAddPersonalModel).toBeTypeOf("function");
    await act(async () => {
      await card().onAddPersonalModel?.("ucas", "manual-model", {});
    });
    expect(addPersonalModelMock).toHaveBeenCalledExactlyOnceWith("ucas", "manual-model", {});
    expectNoAccountActions();
  });

  it("删除个人供应商经确认后只调用个人配置服务", async () => {
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(createElement(ModelProviderSection));
    await act(async () => {
      await card().onDelete?.();
    });
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(deleteProviderMock).toHaveBeenCalledExactlyOnceWith("custom-provider");
    expectNoAccountActions();
  });

  it("新增供应商沿用二十次解锁并由个人配置工厂创建", async () => {
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(createElement(ModelProviderSection));
    expect(layout().addProviderLocked).toBe(true);
    for (let index = 0; index < 10; index += 1) act(() => layout().onAddProvider());
    act(() => layout().onResetAddProviderClickSequence());
    for (let index = 0; index < 19; index += 1) act(() => layout().onAddProvider());
    expect(layout().addProviderLocked).toBe(true);
    expect(createPersonalProviderMock).not.toHaveBeenCalled();
    act(() => layout().onAddProvider());
    expect(layout().addProviderLocked).toBe(false);
    act(() => layout().onAddProvider());
    expect(pickerProps).not.toBeNull();
    await act(async () => {
      await pickerProps!.onCreateCustom("Manual provider");
    });
    expect(createPersonalProviderMock).toHaveBeenCalledExactlyOnceWith({
      providerName: "Manual provider",
      locale: "zh-CN",
    });
    expectNoAccountActions();
  });

  it("旧套餐导航意图仅被消费，不重新打开账号入口", async () => {
    const consume = vi.fn();
    const { ModelProviderSection } = await import("@/settings/ModelProviderSection.js");
    render(
      createElement(ModelProviderSection, {
        pendingModelProviderTarget: { providerId: "account:zai-individual-coding-plan" },
        onConsumePendingModelProviderTarget: consume,
      }),
    );
    expect(consume).toHaveBeenCalledOnce();
    expect(card().provider.providerId).toBe("custom-provider");
    expectNoAccountActions();
  });
});
