import type { IEnterpriseIdentityService } from "./contract.js";

/** 消费者读取姓名；退出不删除本地工作区。 */
export async function readEnterpriseDisplayName(
  service: IEnterpriseIdentityService,
): Promise<string | null> {
  const view = await service.getView();
  return view.status === "authenticated" ? view.profile.displayName : null;
}
