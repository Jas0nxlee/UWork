/**
 * 会话暖启动窗口的重试策略（spec: specs/plugin-ui-session-warmup-resilience.md）。
 *
 * 应用冷启动恢复任务时，渲染端会立刻为历史工具卡挂载页面，而会话的 MCP app 连接尚未登记：
 * host 的 `mcp/uiOpenInstance` 会立刻回 -32001 "MCP App connection is unavailable"。
 * 这是瞬态（同一秒 readSession 还是 Session is not active），不该落成"加载失败让用户手点重试"。
 */

/** host 侧 app 连接快照尚未登记：bootstrap/src/zcode-protocol/mcp-ui/protocol.ts 的 openMcpUiInstance。 */
const MCP_APP_CONNECTION_UNAVAILABLE_CODE = -32001;
const MCP_APP_CONNECTION_UNAVAILABLE_MESSAGE = "MCP App connection is unavailable";

/** 退避表即预算：5 次共 7.75s。用尽仍失败就交回卡片的手动重试，不无限等待。 */
export const PLUGIN_UI_PREPARE_WARMUP_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

/** 只认"连接未就绪"这一类：其余错误（参数校验 -32602、资源被拒、握手超时）必须立刻失败。 */
export function isTransientPluginUiPrepareError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === MCP_APP_CONNECTION_UNAVAILABLE_CODE) return true;
  }
  return error instanceof Error && error.message.includes(MCP_APP_CONNECTION_UNAVAILABLE_MESSAGE);
}

export interface PluginUiWarmupRetryOptions {
  /** 已释放：原样抛出，不再多等一轮。 */
  isDisposed?: () => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** 注入点：单测用假睡眠，避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
}

export async function retryPluginUiWarmup<T>(
  run: () => Promise<T>,
  options: PluginUiWarmupRetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? PLUGIN_UI_PREPARE_WARMUP_DELAYS_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const delay = delays[attempt];
      if (
        delay === undefined ||
        options.isDisposed?.() ||
        !isTransientPluginUiPrepareError(error)
      ) {
        throw error;
      }
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
      if (options.isDisposed?.()) throw error;
    }
  }
}
