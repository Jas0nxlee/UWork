import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { logger } from "@/logger.js";
import type { ModelPreviewFormat } from "@/lib/modelPreview.js";
import type { ModelPreviewViewerLabels } from "@/modelPreview/ModelPreviewViewer.js";

// three.js 与各格式 loader 只在这个 chunk 里（viewer 懒加载），
// 主包与普通文本/图片预览都不承担这部分体积。
const LazyModelPreviewViewer = lazy(async () => {
  const module = await import("@/modelPreview/ModelPreviewViewer.js");
  return { default: module.ModelPreviewViewer };
});

class ModelPreviewErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("[PreviewPane] 3D 预览组件渲染失败", {
      error: error.message,
      componentStack: info.componentStack ?? "",
    });
  }

  componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/**
 * 3D 预览的入口：字节已经由 PreviewPane 读好，这里只处理"还没读到/读不到"，
 * 以及懒加载 three 期间的占位与渲染期异常的兜底（否则一个渲染异常会让整块预览变空白）。
 */
export function PreviewPaneModelContent({
  data,
  error,
  format,
  labels,
  loading,
  modelPath,
  readBytes,
  resolvedTheme,
}: {
  data: Uint8Array | null;
  error: string | null;
  format: ModelPreviewFormat;
  labels: ModelPreviewViewerLabels;
  loading: boolean;
  modelPath: string;
  readBytes: (path: string) => Promise<Uint8Array>;
  resolvedTheme: "light" | "dark";
}) {
  if (loading || (!error && !data)) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>;
  }
  if (error || !data) {
    return (
      <div className="p-3 text-ui-base text-destructive" role="alert">
        {error ?? labels.unavailable}
      </div>
    );
  }

  return (
    <ModelPreviewErrorBoundary
      fallback={
        <div className="p-3 text-ui-base text-destructive" role="alert">
          {labels.unavailable}
        </div>
      }
      resetKey={`${format}:${modelPath}:${data.byteLength}`}
    >
      <Suspense
        fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
      >
        <LazyModelPreviewViewer
          data={data}
          format={format}
          labels={labels}
          modelPath={modelPath}
          readBytes={readBytes}
          resolvedTheme={resolvedTheme}
        />
      </Suspense>
    </ModelPreviewErrorBoundary>
  );
}
