import { useCallback, useEffect, useRef, useState } from "react";
import type { IUcasGatewayService } from "@zcode/services";
import {
  ucasGatewayViewSchema,
  type UcasGatewaySyncResult,
  type UcasGatewayUsageMetric,
  type UcasGatewayUsagePeriod,
  type UcasGatewayView,
} from "@zcode/shared";
import { useOptionalBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface UcasGatewayController {
  /** 当前 Host 是否注册了企业网关服务。 */
  available: boolean;
  view: UcasGatewayView | null;
  busy: boolean;
  period: UcasGatewayUsagePeriod;
  metric: UcasGatewayUsageMetric;
  sync(): Promise<UcasGatewaySyncResult | null>;
  setPeriod(period: UcasGatewayUsagePeriod): void;
  setMetric(metric: UcasGatewayUsageMetric): void;
  refreshUsage(force: boolean): Promise<void>;
  refreshModels(): Promise<void>;
  applyModels(): Promise<void>;
  replaceApiKey(): Promise<void>;
}

/**
 * 企业网关视图的唯一 UI 绑定：订阅 Host 事件并提交权威快照，
 * 组件不直接持有凭据或自行推断同步结果。
 */
export function useUcasGateway(): UcasGatewayController {
  // 企业网关是设备级事实（与身份同源），必须读 base host；远端 workspace 的
  // ServiceProvider 不能替换它，否则面板会指向远端 Host 的空状态。
  const services = useOptionalBaseWorkspaceServices();
  const service: IUcasGatewayService | null = services?.ucasGatewayService ?? null;
  const [view, setView] = useState<UcasGatewayView | null>(null);
  const [busy, setBusy] = useState(false);
  // 周期/指标以服务端视图回显为唯一事实，本地只保存"刚点下、还没拿到结果"的选择：
  // 面板切分区或重挂载时不会被重置回默认值再回查一次（那会让数字在周期之间跳）。
  const [pendingSelection, setPendingSelection] = useState<{
    period: UcasGatewayUsagePeriod;
    metric: UcasGatewayUsageMetric;
  } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!service) {
      setView(null);
      return;
    }
    let active = true;
    const apply = (candidate: unknown) => {
      if (!active) return;
      const parsed = ucasGatewayViewSchema.safeParse(candidate);
      if (parsed.success) setView(parsed.data);
      else logger.warn("UCAS gateway view projection rejected an invalid payload");
    };
    const subscription = service.onDidChange(apply);
    void service
      .getView()
      .then(apply)
      .catch(() => logger.warn("UCAS gateway view could not be loaded"));
    return () => {
      active = false;
      generation.current++;
      subscription.dispose();
    };
  }, [service]);

  const run = useCallback(async (operation: () => Promise<unknown>): Promise<void> => {
    const current = ++generation.current;
    setBusy(true);
    try {
      await operation();
    } catch {
      // 服务已把失败写入 View；这里只记录本地异常，不复制错误详情（可能含服务端诊断）。
      logger.warn("UCAS gateway operation failed");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, []);

  const sync = useCallback(async (): Promise<UcasGatewaySyncResult | null> => {
    if (!service) return null;
    const current = ++generation.current;
    setBusy(true);
    try {
      const result = await service.sync("manual");
      if (generation.current === current) setView(result.view);
      return result;
    } catch {
      logger.warn("UCAS gateway sync failed");
      return null;
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [service]);

  const loadedPeriod = view?.usage?.period ?? null;
  const loadedMetric = view?.usage?.metric ?? null;
  // 服务端已回显这次选择后，本地不再保留它：之后的重挂载直接读视图。
  useEffect(() => {
    if (!pendingSelection || loadedPeriod === null || loadedMetric === null) return;
    if (pendingSelection.period === loadedPeriod && pendingSelection.metric === loadedMetric) {
      setPendingSelection(null);
    }
  }, [pendingSelection, loadedPeriod, loadedMetric]);

  const period = pendingSelection?.period ?? loadedPeriod ?? "month";
  const metric = pendingSelection?.metric ?? loadedMetric ?? "requests";

  const requestUsage = useCallback(
    (next: { period: UcasGatewayUsagePeriod; metric: UcasGatewayUsageMetric }, force: boolean) => {
      if (!service) return Promise.resolve();
      setPendingSelection(next);
      return run(() => service.refreshUsage({ ...next, force }));
    },
    [service, run],
  );

  const refreshUsage = useCallback(
    (force: boolean) => requestUsage({ period, metric }, force),
    [requestUsage, period, metric],
  );

  return {
    available: service !== null,
    view,
    busy,
    period,
    metric,
    sync,
    setPeriod: (next) => void requestUsage({ period: next, metric }, false),
    setMetric: (next) => void requestUsage({ period, metric: next }, false),
    refreshUsage,
    refreshModels: () => (service ? run(() => service.refreshModels()) : Promise.resolve()),
    applyModels: () => (service ? run(() => service.applyModels()) : Promise.resolve()),
    replaceApiKey: () => (service ? run(() => service.replaceApiKey()) : Promise.resolve()),
  };
}
