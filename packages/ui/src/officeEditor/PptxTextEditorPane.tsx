/**
 * PPTX 的**文字编辑位**（幻灯片列表 + 文本块编辑，写回只改 `a:t` 文本节点）。
 *
 * 定位说清楚（也写在界面上）：这不是 WYSIWYG 排版编辑器——拖拽、加形状、改动画都没有。
 * 它解决的是"**改字**"这件事，而且改得安全：只有被编辑的那几张 `slideN.xml` 会被替换，
 * 图片、母版、版式、动画、备注逐字节保留（由 pptxValidate 的"未编辑部件必须逐字节一致"盯着）。
 * 不加富文本编辑器的理由见 specs/office-editors-triad.md：可用的 OSS pptx 编辑器只有 AGPL 的 PPTist。
 */
import type { IFileService } from "@zcode/services";
import { useEffect, useMemo, useState } from "react";
import { OfficeEditorToolbar } from "./OfficeEditorToolbar.js";
import { usePptxDocument } from "./usePptxDocument.js";

export interface PptxTextEditorPaneProps {
  fileService: IFileService;
  path: string;
  remote?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onExit?: () => void;
}

export function PptxTextEditorPane({
  fileService,
  path,
  remote,
  onDirtyChange,
  onExit,
}: PptxTextEditorPaneProps) {
  const {
    status,
    setStatus,
    slides,
    dirty,
    busy,
    writeBlocked,
    loadDocument,
    save,
    setBlockLines,
  } = usePptxDocument({ fileService, path, remote, onDirtyChange });
  const [activeSlide, setActiveSlide] = useState(0);

  useEffect(() => {
    setActiveSlide(0);
  }, [path]);

  const slide = slides?.[activeSlide];
  const blocks = useMemo(() => slide?.blocks ?? [], [slide]);
  const totalBlocks = useMemo(
    () => (slides ?? []).reduce((total, item) => total + item.blocks.length, 0),
    [slides],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OfficeEditorToolbar
        busy={busy}
        dirty={dirty}
        status={status}
        onSave={() => void save()}
        onReload={() => {
          void loadDocument().catch((error) => setStatus(`重新加载失败：${String(error)}`));
        }}
        onExit={onExit}
        confirmExit={() => !dirty || window.confirm("有未保存的文字改动，确定退出编辑吗？")}
      />
      {writeBlocked ? (
        <div className="border-b border-border bg-surface px-3 py-3 text-xs">
          <div className="pb-1 font-medium">这份演示文稿现在不能应用内编辑</div>
          <div className="text-foreground-subtle">{writeBlocked}</div>
        </div>
      ) : null}
      <div className="border-b border-border bg-surface px-3 py-2 text-[11px] text-foreground-subtle">
        只编辑**文字**：版式、图片、动画、母版、备注原样保留（只替换改过的那几张幻灯片 XML）。
        同一段里的多种字体在被改动的那一行会折叠成首个字体；文本框位置/大小请在 PowerPoint/WPS
        里调整。
      </div>
      {slides === null ? (
        <div className="flex flex-1 items-center justify-center text-xs text-foreground-subtle">
          正在打开演示文稿…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-32 shrink-0 overflow-y-auto border-r border-border">
            {slides.map((item, index) => (
              <button
                key={item.partName}
                type="button"
                data-pptx-slide={index + 1}
                className={`block w-full px-2 py-2 text-left text-xs ${
                  index === activeSlide
                    ? "bg-accent/20 font-medium text-accent"
                    : "text-foreground hover:bg-surface"
                }`}
                onClick={() => setActiveSlide(index)}
              >
                <span className="pr-1 text-foreground-subtle">第 {index + 1} 页</span>
                {item.blocks.length === 0 ? (
                  <span className="text-foreground-subtlest">（无文字）</span>
                ) : null}
                <div className="truncate text-[11px] text-foreground-subtle">
                  {item.blocks
                    .flatMap((block) => block.lines)
                    .join(" ")
                    .slice(0, 24) || "—"}
                </div>
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {blocks.length === 0 ? (
              <div className="py-6 text-center text-xs text-foreground-subtle">
                这一页没有可编辑的文字（可能整页都是图片）
              </div>
            ) : slide ? (
              blocks.map((block) => (
                <div key={block.index} className="pb-3">
                  <div className="pb-1 text-[11px] text-foreground-subtle">
                    文本 {block.index + 1} · {block.label}
                  </div>
                  <textarea
                    data-pptx-block={`${slide.partName}#${block.index}`}
                    className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-[13px] leading-relaxed"
                    rows={Math.min(12, Math.max(2, block.lines.length + 1))}
                    value={block.lines.join("\n")}
                    onChange={(event) => {
                      setBlockLines(slide.partName, block.index, event.target.value.split("\n"));
                    }}
                  />
                </div>
              ))
            ) : null}
          </div>
        </div>
      )}
      <div className="border-t border-border px-3 py-1 text-[11px] text-foreground-subtlest">
        共 {slides?.length ?? 0} 页 / {totalBlocks} 个文本块
      </div>
    </div>
  );
}
