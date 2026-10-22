import type { IImService } from "./contract.js";

/** 注入宿主已有的服务实例，未连接时不把未知准入当作无权限。 */
export async function exampleImView(service: IImService) {
  return service.getView();
}
