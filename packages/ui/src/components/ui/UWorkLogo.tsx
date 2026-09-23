import { cn } from "@/components/lib/utils.js";

export const UWORK_MARK_PATH =
  "M40 12H86V128C86 160 100 176 128 176C156 176 170 160 170 128V12H216V130C216 187 184 216 128 216C72 216 40 187 40 130Z";

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
