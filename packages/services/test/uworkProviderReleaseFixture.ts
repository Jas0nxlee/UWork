import { readFile } from "node:fs/promises";
import { decodeZCodeBuiltinRelease } from "@zcode/provider-node";
import { UCAS_PROVIDER_TEMPLATE_ID } from "@zcode/provider";

// Host 必须播种 UCAS；从真实随包资源取模板，避免空上游 fixture 冒充有效 UWork 安装。
const bundled = decodeZCodeBuiltinRelease(
  JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  ),
);
const template = bundled.config.providerTemplates
  .toJSON()
  .find((rule) => rule.templateId === UCAS_PROVIDER_TEMPLATE_ID);
if (!template) throw new Error("UWork bundled release must provide the UCAS template");

export function createUcasTemplateFixture() {
  return structuredClone(template);
}
