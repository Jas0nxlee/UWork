import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type EnterpriseIdentityAttempt,
  type EnterpriseIdentityCompletion,
  type EnterpriseIdentityPollResult,
  type EnterpriseIdentitySession,
  type EnterpriseIdentityView,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 应用级身份 RPC。视图与事件不包含 Token；不提供 Renderer 自行设置姓名的接口。 */
export interface IEnterpriseIdentityService {
  getView(): Promise<EnterpriseIdentityView>;
  restoreSession(): Promise<EnterpriseIdentityView>;
  /**
   * 记住本机选择的组织（设备偏好，不参与授权判断）。必须出现在配置清单里，
   * 否则拒绝；选择只影响后续扫码用哪家企微应用。
   */
  selectOrganization(orgId: string): Promise<EnterpriseIdentityView>;
  beginLogin(): Promise<EnterpriseIdentityAttempt>;
  pollLogin(attemptId: string): Promise<EnterpriseIdentityView>;
  completeLogin(attemptId: string, callbackUrl: string): Promise<EnterpriseIdentityCompletion>;
  cancelLogin(attemptId: string): Promise<void>;
  logout(): Promise<void>;
  onDidChange: Event<EnterpriseIdentityView>;
}
export const IEnterpriseIdentityService = createServiceDescriptor<IEnterpriseIdentityService>(
  ServiceChannels.EnterpriseIdentity,
);

/** 适配器对外暴露的组织选项（白名单来源是已校验的公开配置）。 */
export interface EnterpriseIdentityOrganizationOption {
  id: string;
  label?: string;
}

export interface EnterpriseIdentityAdapter {
  /** 配置里可选的组织清单；单组织部署长度为 1，未配置时为空数组。 */
  listOrganizations(): EnterpriseIdentityOrganizationOption[];
  /** 解析目标组织：显式 id 必须命中清单；缺省时按 defaultOrgId → 清单唯一项，未命中返回 undefined。 */
  resolveOrganization(orgId?: string | null): EnterpriseIdentityOrganizationOption | undefined;
  /** `orgId` 缺省时用配置默认；未列出的组织一律抛错，不回落别家。 */
  start(signal: AbortSignal, orgId?: string): Promise<EnterpriseIdentityAttempt>;
  poll?(attemptId: string, signal: AbortSignal): Promise<EnterpriseIdentityPollResult>;
  /** 仅 Host 使用 code 调已有服务；UI 不收到 token。 */
  complete?(code: string, signal: AbortSignal, orgId?: string): Promise<EnterpriseIdentitySession>;
  restore(
    session: EnterpriseIdentitySession,
    signal: AbortSignal,
  ): Promise<EnterpriseIdentitySession | null>;
  revoke?(session: EnterpriseIdentitySession): Promise<void>;
}
