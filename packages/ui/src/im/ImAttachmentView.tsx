import { memo, useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import { isInlineImageMime, parseImAttachmentBody } from "@zcode/shared";
import { DownloadIcon, FileIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/** 人类可读体积（1 位小数够用）。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/**
 * 附件消息的渲染。
 *
 * 两个判断：
 * 1. **图片内联、其它一律给卡片**：内联只认位图（png/jpeg/gif/webp/bmp/avif），SVG 不内联
 *    （它是可以带脚本的向量，塞进 `<img>` 之外的地方风险更大）。
 * 2. **字节用带鉴权的 fetch 取成 blob**：`<img src>` 带不了 Authorization 头，
 *    所以不能直接把服务端 URL 丢给 img——那要么 401，要么得在 URL 里塞令牌（会进日志）。
 */
export const ImAttachmentView = memo(function ImAttachmentView({
  service,
  body,
}: {
  service: IImService | null;
  body: string;
}) {
  const { intl } = useZCodeIntl();
  // 用可选版本：宿主没提供平台能力（Web/手机页）时要降级成浏览器下载，而不是整块崩掉。
  const platform = useOptionalPlatform();
  const t = (id: string): string => intl.formatMessage({ id });
  const attachment = parseImAttachmentBody(body);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /** 保存成功后就地告诉用户落在哪——不然"点了一下"和"没反应"看起来一样。 */
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const inlineImage = attachment !== null && isInlineImageMime(attachment.mime);

  useEffect(() => {
    if (!service || !attachment || !inlineImage) return;
    let active = true;
    let objectUrl: string | null = null;
    void service
      .downloadAttachment(attachment.attachmentId)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes.slice().buffer], { type: attachment.mime }),
        );
        setImageUrl(objectUrl);
      })
      .catch((error: unknown) => {
        logger.warn("[im] 附件读取失败", error);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      // 释放 object URL：不释放的话切来切去会一直占内存（图片是这个面板里最大的对象）。
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [service, attachment?.attachmentId, inlineImage, attachment?.mime]);

  if (!attachment) {
    // 载荷认不出（旧版本/手改的数据）：退化成一行提示，别静默消失。
    return (
      <p className="mt-0.5 text-ui-xs text-foreground-subtle italic">{t("im.attachmentBroken")}</p>
    );
  }

  /**
   * 下载：**桌面端走宿主落盘**（`saveImAttachment` → 下载目录/UWork），
   * 渲染层的 `<a download>` 在 Electron 里不会真的写文件（实测点完什么都不发生）。
   * 网页端没有这个能力，退回到浏览器下载语义。
   */
  const download = async (): Promise<void> => {
    if (!service) return;
    setDownloading(true);
    setSavedPath(null);
    try {
      const bytes = await service.downloadAttachment(attachment.attachmentId);
      if (platform?.saveImAttachment) {
        const saved = await platform.saveImAttachment({ name: attachment.name, bytes });
        setSavedPath(saved.path);
      } else {
        const url = URL.createObjectURL(
          new Blob([bytes.slice().buffer], { type: attachment.mime }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = attachment.name;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      logger.warn("[im] 附件下载失败", error);
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  if (inlineImage) {
    return (
      <div className="mt-1">
        {failed ? (
          <p className="text-ui-xs text-foreground-subtle italic">{t("im.attachmentFailed")}</p>
        ) : imageUrl ? (
          <button
            type="button"
            data-testid="im-attachment-image"
            className="block max-w-full overflow-hidden rounded-lg border border-border"
            onClick={() => void download()}
            title={t("im.attachmentDownload")}
          >
            <img
              src={imageUrl}
              alt={attachment.name}
              className="max-h-72 max-w-full object-contain"
            />
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-2 py-1.5 text-ui-2xs text-foreground-subtle">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t("im.attachmentLoading")}
          </span>
        )}
        <span className="mt-1 block text-ui-2xs text-foreground-subtle">
          {attachment.name} · {formatBytes(attachment.size)}
        </span>
        {savedPath ? (
          <span
            data-testid="im-attachment-saved"
            className="mt-0.5 block text-ui-2xs text-foreground-subtle"
          >
            {t("im.attachmentSaved")} {savedPath}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid="im-attachment-file"
      className={cn(
        "mt-1 flex max-w-sm items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-border-hover",
      )}
      onClick={() => void download()}
    >
      <FileIcon className="size-5 shrink-0 text-foreground-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-sm text-foreground">{attachment.name}</span>
        <span className="block text-ui-2xs text-foreground-subtle">
          {failed
            ? t("im.attachmentFailed")
            : savedPath
              ? `${t("im.attachmentSaved")} ${savedPath}`
              : formatBytes(attachment.size)}
        </span>
      </span>
      <DownloadIcon
        className={cn("size-4 shrink-0 text-foreground-subtle", downloading && "animate-pulse")}
      />
    </button>
  );
});
