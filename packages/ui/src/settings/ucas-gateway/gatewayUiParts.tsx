import type { ReactNode } from "react";
import type {
  UcasGatewayError,
  UcasGatewayUsageMetric,
  UcasGatewayUsagePeriod,
} from "@zcode/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { cn } from "@/components/lib/utils.js";

export type Translate = (id: string, values?: Record<string, string | number>) => string;

export const PERIODS: UcasGatewayUsagePeriod[] = ["7d", "month", "30d"];
export const METRICS: UcasGatewayUsageMetric[] = ["requests", "cost", "tokens"];
export const ERROR_IDS: Record<UcasGatewayError, string> = {
  "signed-out": "error.signedOut",
  unconfigured: "error.unconfigured",
  unauthorized: "error.unauthorized",
  network: "error.network",
  failed: "error.failed",
};

/** 区块卡片：标题与内容用分隔线断开，内容区留出层级间距，避免整块平面铺开。 */
export function SectionCard({
  icon,
  title,
  aside,
  children,
}: {
  icon: ReactNode;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 border-b border-border/70">
        <span className="flex size-5 items-center justify-center text-foreground-subtle">
          {icon}
        </span>
        <CardTitle className="text-ui-base font-medium">{title}</CardTitle>
        {aside ? <span className="ml-auto flex items-center gap-1.5">{aside}</span> : null}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

/** 内层信息块：卡片内的第二层容器，给键值对与数字一个可读的边界。 */
export function InfoTile({
  label,
  value,
  className,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border border-border/60 bg-surface/50 px-3 py-2",
        className,
      )}
    >
      <div className="truncate text-ui-sm text-foreground-subtle">{label}</div>
      <div className={cn("truncate text-ui-base font-medium text-foreground", valueClassName)}>
        {value}
      </div>
    </div>
  );
}

/** 键值一行：标签左、值右，用于网关地址这类单条事实。 */
export function FieldRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-ui-base text-foreground-subtle">{label}</span>
      <span className="min-w-0 truncate text-ui-base text-foreground">{value}</span>
    </div>
  );
}
