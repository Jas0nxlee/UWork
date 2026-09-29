import type { IEnterpriseIdentityService } from "./contract.js";

const disposers = new WeakMap<IEnterpriseIdentityService, () => Promise<void>>();

/** 只释放仍属于该 promise 的单次操作引用，不让迟到任务清掉较新的操作。 */
export function releaseIdentityOperation<T>(task: Promise<T>, release: () => void): Promise<T> {
  void task.finally(release).catch(() => {});
  return task;
}

/** 注册 Node owner 的资源回收，不能暴露为 Renderer RPC。 */
export function registerIdentityServiceDisposer(
  service: IEnterpriseIdentityService,
  dispose: () => Promise<void>,
): void {
  disposers.set(service, dispose);
}

export async function disposeEnterpriseIdentityService(
  service: IEnterpriseIdentityService,
): Promise<void> {
  await disposers.get(service)?.();
  disposers.delete(service);
}
