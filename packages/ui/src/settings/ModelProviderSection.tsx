import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import {
  getProviderFormLabel,
  getProviderFormApiKeyManagementUrl,
} from "@/lib/providerSettingsFormTypes.js";
import {
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import type { ModelProviderNavGroup } from "./model-provider-section/constants.js";
import { InlineEditableProviderCard } from "./model-provider-section/InlineEditableProviderCard.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

/** 供应商事实仅来自 Host；此处只拥有选中项与新增表单等局部状态。 */
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    discoverModels,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const providers = useMemo(
    () =>
      sortModelProvidersForDisplay(
        modelProviders.filter((provider) => provider.config.group === "standard-personal"),
        displayOrder,
      ),
    [modelProviders, displayOrder],
  );
  const selectedProvider =
    providers.find((provider) => provider.providerId === selectedProviderId) ?? providers[0];
  const navigationGroups: ModelProviderNavGroup[] = [
    {
      id: "custom",
      title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
      items: providers.map((provider) => ({
        key: createCustomProviderNodeKey(provider.providerId),
        type: "custom",
        label: getProviderFormLabel(provider),
        provider,
        statusActive: provider.executable === true,
      })),
    },
  ];
  useEffect(() => {
    // 旧套餐导航意图不再恢复账号入口，统一落到自定义配置页。
    consumePendingSettingsModelProviderTarget();
    if (pendingModelProviderTarget) onConsumePendingModelProviderTarget?.();
  }, [pendingModelProviderTarget, onConsumePendingModelProviderTarget]);
  const createProvider = async (input: { templateId?: string; providerName?: string }) => {
    setCreatingProvider(true);
    try {
      const created = await createPersonalProvider({ ...input, locale });
      // 直接保留 id，快照尚未到达时使用首项投影；快照到达后自动切换，不用定时补偿。
      setSelectedProviderId(created.providerId);
      setTemplatePickerOpen(false);
    } finally {
      setCreatingProvider(false);
    }
  };
  if (loadError)
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  const keyUrl = selectedProvider?.templateId
    ? getProviderFormApiKeyManagementUrl(selectedProvider)
    : undefined;
  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={false}
      customLoading={loading || refreshing}
      onRefresh={() => void refresh()}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={
        selectedProvider ? createCustomProviderNodeKey(selectedProvider.providerId) : null
      }
      onSelectNavItem={(item) => {
        if (item.type === "custom") setSelectedProviderId(item.provider.providerId);
        setTemplatePickerOpen(false);
      }}
      onReorderProviderIds={(providerIds) => saveDisplayOrder({ providerIds })}
      reorderableProviderIds={reorderableProviderIds}
    >
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => createProvider({ templateId })}
          onCreateCustom={(providerName) => createProvider({ providerName })}
        />
      ) : selectedProvider ? (
        <InlineEditableProviderCard
          key={selectedProvider.providerId}
          provider={selectedProvider}
          onSave={async (provider) => {
            await saveProvider(provider);
          }}
          onDiscoverModels={discoverModels}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={() =>
            confirmAndDeleteModelProvider({
              provider: selectedProvider,
              confirmDialog,
              intl,
              deleteProvider,
            })
          }
          onTestModel={testModelConnectivity}
          onReorderModelIds={(ids) => reorderProviderModels(selectedProvider.providerId, ids)}
          presetApiKeyUrl={keyUrl}
          onOpenPresetApiKey={keyUrl ? () => platform.openExternal(keyUrl) : undefined}
          readOnlyEndpoints={false}
          nameEditable
        />
      ) : (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: loading ? "common.loading" : "settings.modelProviderDescription",
          })}
        </p>
      )}
    </ModelProviderSectionLayout>
  );
}
