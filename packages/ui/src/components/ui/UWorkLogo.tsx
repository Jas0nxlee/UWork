import { cn } from "@/components/lib/utils.js";

/**
 * U 标记：圆头笔画 + 连续圆角（外底 r88 / 内底 r32、笔画 56），与随包图标同源同几何。
 * 旧的方头直角版本在大字号下观感生硬，这里统一改为柔化轮廓；外接尺寸不变（176×204）。
 */
export const UWORK_MARK_PATH =
  "M40 40 A28 28 0 0 1 96 40 L96 128 A32 32 0 0 0 160 128 L160 40 A28 28 0 0 1 216 40 L216 128 A88 88 0 0 1 40 128 Z";

export function UWorkLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 228"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <path d={UWORK_MARK_PATH} />
    </svg>
  );
}

export function UWorkWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 232 64"
      role="img"
      aria-label="UWork"
      className={cn("shrink-0", className)}
      data-testid="uwork-wordmark"
    >
      <text
        x="0"
        y="49"
        fill="currentColor"
        fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif"
        fontSize="54"
        fontWeight="800"
        letterSpacing="-2"
      >
        UWork
      </text>
    </svg>
  );
}
