import {
  EnumOptionSpecConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
} from "./config/model-config.js";

export const UCAS_PROVIDER_ID = "ucas";
export const UCAS_PROVIDER_TEMPLATE_ID = "ucas";
export const UCAS_PROVIDER_NAME = "ucas";
export const UCAS_BASE_URL = "https://lm.ucas.com.cn:15000/v1";
export const UCAS_API_TYPE = "openai-chat-completions" as const;

export const UCAS_DEFAULT_MODEL_IDS = Object.freeze([
  "ucas-deepseek-flash",
  "ucas-gpt-max",
  "ucas-gpt-mini",
  "ucas-kimi",
  "ucas-glm",
  "ucas-gemini-flash",
]);

export function createUcasDefaultModelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      contextWindow: 1_000_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: true,
      }),
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: new EnumOptionSpecConfig({ values: ["low", "high", "max"] }),
    }),
  });
}
