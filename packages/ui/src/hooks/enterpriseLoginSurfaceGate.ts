import type { EnterpriseLoginSurface } from "@zcode/shared";

/** DOM 几何的就绪握手只用于展示，不拥有 Host 的登录状态。取消后不能唤起迟到的 native view。 */
export function createEnterpriseLoginSurfaceGate() {
  let snapshot: EnterpriseLoginSurface | null = null;
  const waiting = new Set<(surface: EnterpriseLoginSurface) => void>();
  return {
    publish(surface: EnterpriseLoginSurface | null) {
      snapshot = surface;
      if (surface) for (const resolve of waiting) resolve(surface);
    },
    wait(signal: AbortSignal): Promise<EnterpriseLoginSurface> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (snapshot) return Promise.resolve(snapshot);
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          waiting.delete(accept);
          signal.removeEventListener("abort", abort);
        };
        const accept = (surface: EnterpriseLoginSurface) => {
          cleanup();
          resolve(surface);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        waiting.add(accept);
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
