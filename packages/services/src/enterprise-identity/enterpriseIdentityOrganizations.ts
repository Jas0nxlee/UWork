import type { EnterpriseIdentityView } from "@zcode/shared";
import type { EnterpriseIdentityOrganizationOption } from "./contract.js";
import type { IdentityOrganizationStore } from "./identityOrganizationStore.js";

/**
 * 组织选择（设备偏好）：只决定扫码用哪家企微应用，**不参与授权判断**。
 * 记忆值必须命中配置清单，否则回落到配置默认组织；未列出的组织一律拒绝。
 */
export interface EnterpriseIdentityOrganizationSelection {
  /** 视图投影用的清单（label 缺失时给 null，由 UI 回落 id）。 */
  options(): EnterpriseIdentityView["organizations"];
  current(): string | null;
  /** 读记忆 → 校验 → 回落默认；返回最终选中的组织。 */
  hydrate(): Promise<string | null>;
  /** 校验并记住选择；未列出/空白值抛错，不静默回落。 */
  select(orgId: string): Promise<string>;
  /** 等待此前已接收的全部选择（包含尚未进入持久化队列的选择）。 */
  settled(): Promise<void>;
}

export function createEnterpriseIdentityOrganizationSelection(options: {
  listOrganizations: () => EnterpriseIdentityOrganizationOption[];
  resolveOrganization: (orgId?: string | null) => EnterpriseIdentityOrganizationOption | undefined;
  persist: (orgId: string) => Promise<void>;
  store?: IdentityOrganizationStore;
}): EnterpriseIdentityOrganizationSelection {
  let selectedOrgId: string | null = null;
  let selections: Promise<unknown> = Promise.resolve();
  const resolveStored = async (): Promise<string | null> => {
    let stored: string | null = null;
    try {
      stored = (await options.store?.read()) ?? null;
    } catch {
      // 偏好文件不可读不影响登录：按未选择处理，让配置默认组织兜底。
      stored = null;
    }
    const resolved =
      (stored ? options.resolveOrganization(stored) : undefined) ?? options.resolveOrganization();
    return resolved?.id ?? null;
  };
  return {
    options: () =>
      options.listOrganizations().map((organization) => ({
        id: organization.id,
        label: organization.label ?? null,
      })),
    current: () => selectedOrgId,
    settled: async () => {
      await selections;
    },
    hydrate: async () => {
      selectedOrgId = await resolveStored();
      return selectedOrgId;
    },
    select: (orgId) => {
      const resolved = options.resolveOrganization(orgId);
      if (!resolved || resolved.id !== orgId.trim())
        return Promise.reject(new Error("企业身份组织不可用"));
      // 写入成功才提交内存选择；串行化防止旧失败回滚新选择，确保视图与扫码组织一致。
      const task = selections.then(async () => {
        await options.persist(resolved.id);
        selectedOrgId = resolved.id;
        return resolved.id;
      });
      selections = task.catch(() => {});
      return task;
    },
  };
}
