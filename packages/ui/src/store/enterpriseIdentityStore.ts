import { create } from "zustand";
import type { IEnterpriseIdentityService } from "@zcode/services";
import type { EnterpriseIdentityView } from "@zcode/shared";

/** Host 视图的 Renderer 投影；不持久化姓名或 Token，不广播成认证事实。 */
export const useEnterpriseIdentityStore = create<{
  owner: IEnterpriseIdentityService | null;
  view: EnterpriseIdentityView | null;
  attach(owner: IEnterpriseIdentityService | null): void;
  project(owner: IEnterpriseIdentityService, view: EnterpriseIdentityView): void;
}>()((set) => ({
  owner: null,
  view: null,
  attach: (owner) => set({ owner, view: null }),
  project: (owner, view) =>
    set((current) =>
      current.owner === owner && view.revision >= (current.view?.revision ?? -1)
        ? { view }
        : current,
    ),
}));
