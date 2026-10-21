import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelPreviewViewerLabels } from "@/modelPreview/ModelPreviewViewer.js";

/**
 * 3D 模型查看器的本地化标签。
 *
 * 与 PDF / PPTX 的 labels hook 同一理由：文案是**必填全字段**的接口，
 * 漏一个键是类型错误，漏一句翻译只会变成运行时看到 message id。
 */
export function useModelViewerLabels(): ModelPreviewViewerLabels {
  const { intl } = useZCodeIntl();
  return useMemo<ModelPreviewViewerLabels>(
    () => ({
      loading: intl.formatMessage({ id: "codeViewer.loadingModel" }),
      resetView: intl.formatMessage({ id: "codeViewer.model.resetView" }),
      unavailable: intl.formatMessage({ id: "codeViewer.modelUnavailable" }),
      invalidData: intl.formatMessage({ id: "codeViewer.model.invalidData" }),
      emptyModel: intl.formatMessage({ id: "codeViewer.model.empty" }),
      unsupportedExtension: (extensions) =>
        intl.formatMessage({ id: "codeViewer.model.unsupportedExtension" }, { extensions }),
      missingResource: (uri) =>
        intl.formatMessage({ id: "codeViewer.model.missingResource" }, { uri }),
      webglUnavailable: intl.formatMessage({ id: "codeViewer.model.webglUnavailable" }),
      summary: ({ triangles, size }) =>
        intl.formatMessage({ id: "codeViewer.model.summary" }, { triangles, size }),
    }),
    [intl],
  );
}
