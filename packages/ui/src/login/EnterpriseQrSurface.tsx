import { useLayoutEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { enterpriseLoginSurfaceSchema, type EnterpriseLoginSurface } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function EnterpriseQrSurface({
  onSurface,
  label,
}: {
  onSurface(surface: EnterpriseLoginSurface | null): void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { locale } = useZCodeIntl();
  useLayoutEffect(() => {
    let previous = "";
    const measure = () => {
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, rect.left),
        y = Math.max(0, rect.top);
      const width = Math.min(innerWidth, rect.right) - x;
      const height = Math.min(innerHeight, rect.bottom) - y;
      const css = getComputedStyle(element);
      const result = enterpriseLoginSurfaceSchema.safeParse({
        bounds: { x, y, width, height },
        appearance: {
          backgroundColor: css.backgroundColor,
          foregroundColor: css.color,
          fontFamily: css.fontFamily,
          fontSize: parseFloat(css.fontSize),
          language: locale === "en-US" ? "en" : "zh",
        },
      });
      const surface = result.success ? result.data : null;
      const next = JSON.stringify(surface);
      if (next !== previous) {
        previous = next;
        onSurface(surface);
      }
    };
    const resize = new ResizeObserver(measure);
    if (ref.current) resize.observe(ref.current);
    const theme = new MutationObserver(measure);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    return () => {
      resize.disconnect();
      theme.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      onSurface(null);
    };
  }, [onSurface, locale]);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-testid="enterprise-login-qr-surface"
      className="flex h-80 w-full items-center justify-center overflow-hidden rounded-lg bg-card text-foreground"
    >
      <LoaderCircle
        className="size-5 animate-spin text-foreground-subtle motion-reduce:animate-none"
        aria-hidden="true"
      />
    </div>
  );
}
