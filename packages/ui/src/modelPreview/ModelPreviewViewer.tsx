/**
 * 3D 模型预览的 React 外壳。
 *
 * 刻意做小：只读预览 + 轨道相机 + 自动取景 + 一行模型信息 + 重置视角。
 * 没有编辑、导出、动画播放、线框/网格开关，也没有统计面板。
 * 字节由 PreviewPane 用既有的 `readBinaryPreview` 通道读好再传进来（与只读 Office 预览同一条通道）；
 * 场景见 `modelPreviewScene.ts`，解析见 `modelPreviewLoaders.ts`。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { logger } from "@/logger.js";
import {
  disposeObject3D,
  loadModelObject,
  ModelLoadError,
  type ModelLoadFailure,
} from "@/modelPreview/modelPreviewLoaders.js";
import { createScene } from "@/modelPreview/modelPreviewScene.js";

import type { ModelPreviewViewerLabels, ModelPreviewViewerProps } from "./contract.js";
export type { ModelPreviewViewerLabels } from "./contract.js";

function formatDimension(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  if (absolute >= 0.1) return value.toFixed(2);
  return absolute === 0 ? "0" : value.toFixed(3);
}

export function resolveLoadErrorText(error: unknown, labels: ModelPreviewViewerLabels): string {
  const failure: ModelLoadFailure | null = error instanceof ModelLoadError ? error.failure : null;
  switch (failure?.kind) {
    case "unsupported-extension":
      return labels.unsupportedExtension(failure.extensions.join(", "));
    case "missing-resource":
      return labels.missingResource(failure.uri);
    case "invalid-data":
      return labels.invalidData;
    case "empty-model":
      return labels.emptyModel;
    default:
      return labels.unavailable;
  }
}

export function ModelPreviewViewer({
  data,
  format,
  labels,
  modelPath,
  readBytes,
  resolvedTheme,
}: ModelPreviewViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<ReturnType<typeof createScene>>(null);
  // 读取函数每次渲染都可能是新引用；用 ref 承接，避免把"读取函数变了"误当成"换了模型"。
  const readBytesRef = useRef(readBytes);
  readBytesRef.current = readBytes;
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;

  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<"parsing" | "ready" | "error">("parsing");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    // 上下文丢失后原来的 WebGL 上下文已经不可用：换一块**全新**画布（generation 也是它的 key）
    // 重建整个场景，比就地复活更不容易出错。
    const scene = createScene(canvas, themeRef.current, () => setGeneration((value) => value + 1));
    if (!scene) {
      setError(labels.webglUnavailable);
      setPhase("error");
      return;
    }
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
  }, [generation, labels.webglUnavailable]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    let cancelled = false;
    setPhase("parsing");
    setError(null);
    setSummary(null);

    void loadModelObject({
      data,
      format,
      modelPath,
      readBytes: (path) => readBytesRef.current(path),
      onResourceSettled: () => sceneRef.current?.redraw(),
    })
      .then((object) => {
        if (cancelled) {
          // 已经切走/卸载：场景不会再接管这棵树，必须自己释放。
          disposeObject3D(object);
          return;
        }
        const stats = scene.setModel(object);
        setSummary(
          labels.summary({
            triangles: stats.triangles.toLocaleString(),
            size: [stats.size.x, stats.size.y, stats.size.z].map(formatDimension).join(" × "),
          }),
        );
        setPhase("ready");
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        logger.error("[ModelPreview] 3D 模型解析失败", {
          path: modelPath,
          format,
          error: loadError instanceof Error ? loadError.message : String(loadError),
        });
        setError(resolveLoadErrorText(loadError, labels));
        setPhase("error");
      });

    return () => {
      cancelled = true;
    };
  }, [data, format, labels, modelPath]);

  const viewerLabels = useMemo(() => labels, [labels]);

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden bg-background"
      data-model-preview-state={phase}
      data-model-preview-viewer
    >
      <canvas
        key={generation}
        ref={canvasRef}
        aria-hidden="true"
        className="block h-full w-full touch-none"
        data-model-preview-canvas
      />

      {phase === "parsing" ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-ui-base text-foreground-subtle"
          data-model-preview-loading
        >
          {viewerLabels.loading}
        </div>
      ) : null}

      {phase === "error" ? (
        <div
          className="absolute inset-0 flex items-center justify-center p-6 text-center text-ui-base text-destructive"
          data-model-preview-error
          role="alert"
        >
          {error ?? viewerLabels.unavailable}
        </div>
      ) : null}

      {phase === "ready" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1.5 p-2">
          {summary ? (
            <span
              className="pointer-events-auto max-w-[70%] truncate rounded-md border border-border/60 bg-card/85 px-2 py-0.5 text-ui-xs tabular-nums text-foreground-subtle backdrop-blur-sm"
              data-model-preview-summary
            >
              {summary}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-auto border border-border/60 bg-card/85 backdrop-blur-sm"
            aria-label={viewerLabels.resetView}
            data-model-preview-action="reset"
            onClick={() => sceneRef.current?.resetView()}
          >
            <RotateCcw />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
