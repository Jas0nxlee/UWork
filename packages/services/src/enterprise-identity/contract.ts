import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type EnterpriseIdentityAttempt,
  type EnterpriseIdentityPollResult,
  type EnterpriseIdentitySession,
  type EnterpriseIdentityView,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 应用级身份 RPC。视图与事件不包含 Token；不提供 Renderer 自行设置姓名的接口。 */
export interface IEnterpriseIdentityService {
  getView(): Promise<EnterpriseIdentityView>;
  restoreSession(): Promise<EnterpriseIdentityView>;
  beginLogin(): Promise<EnterpriseIdentityAttempt>;
  pollLogin(attemptId: string): Promise<EnterpriseIdentityView>;
  cancelLogin(attemptId?: string): Promise<void>;
  logout(): Promise<void>;
  onDidChange: Event<EnterpriseIdentityView>;
}
export const IEnterpriseIdentityService = createServiceDescriptor<IEnterpriseIdentityService>(
  ServiceChannels.EnterpriseIdentity,
);

/** 仅供 Node 装配注入。待现有认证接口到位后映射，不在客户端假定企业后端协议。 */
export interface EnterpriseIdentityAdapter {
  start(signal: AbortSignal): Promise<EnterpriseIdentityAttempt>;
  poll(attemptId: string, signal: AbortSignal): Promise<EnterpriseIdentityPollResult>;
  restore(
    session: EnterpriseIdentitySession,
    signal: AbortSignal,
  ): Promise<EnterpriseIdentitySession | null>;
  revoke(session: EnterpriseIdentitySession): Promise<void>;
}
