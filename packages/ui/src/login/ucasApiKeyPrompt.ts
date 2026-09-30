import { UCAS_PROVIDER_ID } from "@zcode/provider";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";

type UcasApiKeyService = Pick<IProviderSettingsService, "setUcasApiKeyIfMissing">;

export function hasConfiguredUcasApiKey(view: ProviderSettingsView): boolean {
  const access = view.providers.find((provider) => provider.providerId === UCAS_PROVIDER_ID)
    ?.personalConfig?.access;
  return access?.type === "api-key" && Boolean(access.apiKey?.trim());
}

export async function saveUcasApiKey(service: UcasApiKeyService, key: string): Promise<void> {
  const apiKey = key.trim();
  if (!apiKey) throw new Error("UCAS API Key 不能为空");

  await service.setUcasApiKeyIfMissing(apiKey);
}
