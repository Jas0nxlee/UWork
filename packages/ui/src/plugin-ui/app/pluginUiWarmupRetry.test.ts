import { describe, expect, it, vi } from "vitest";
import { isTransientPluginUiPrepareError, retryPluginUiWarmup } from "./pluginUiWarmupRetry.js";

// spec: specs/plugin-ui-session-warmup-resilience.md —— 冷启动挂载期 -32001 是瞬态，必须自愈。

function connectionUnavailable() {
  return Object.assign(new Error("MCP App connection is unavailable"), { code: -32001 });
}

describe("plugin-ui 暖启动重试", () => {
  it("连续两次连接未就绪后成功：按 250/500ms 退避，结果照常返回", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const result = await retryPluginUiWarmup(
      async () => {
        calls += 1;
        if (calls < 3) throw connectionUnavailable();
        return "mounted";
      },
      { sleep },
    );
    expect(result).toBe("mounted");
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it("非瞬态错误不重试、不等待", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi.fn(async () => {
      throw Object.assign(new Error("MCP App resource binding mismatch"), { code: -32602 });
    });
    await expect(retryPluginUiWarmup(run, { sleep })).rejects.toThrow(/binding mismatch/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("预算用尽（首次 + 5 次退避）后抛出，交回手动重试", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi.fn(async () => {
      throw connectionUnavailable();
    });
    await expect(retryPluginUiWarmup(run, { sleep })).rejects.toThrow(/unavailable/);
    expect(run).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000, 2000, 4000]);
  });

  it("已释放时不再等待", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi.fn(async () => {
      throw connectionUnavailable();
    });
    await expect(retryPluginUiWarmup(run, { sleep, isDisposed: () => true })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("等待期间被释放：重试完这一轮即停", async () => {
    let disposed = false;
    const run = vi.fn(async () => {
      throw connectionUnavailable();
    });
    await expect(
      retryPluginUiWarmup(run, {
        isDisposed: () => disposed,
        sleep: async () => {
          disposed = true;
        },
      }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("瞬态判定认错误码与文案两条", () => {
    expect(isTransientPluginUiPrepareError(connectionUnavailable())).toBe(true);
    expect(isTransientPluginUiPrepareError(new Error("MCP App connection is unavailable"))).toBe(
      true,
    );
    expect(isTransientPluginUiPrepareError(Object.assign(new Error("x"), { code: -32002 }))).toBe(
      false,
    );
    expect(isTransientPluginUiPrepareError("boom")).toBe(false);
  });
});
