export interface RelayRateLimiterOptions {
  maxConnectionsPerIp: number;
  registrationsPerMinutePerIp: number;
  authFailuresPerWindowPerIp: number;
  authFailureWindowMs: number;
  now?: () => number;
}

interface IpState {
  connections: number;
  registrations: number[];
  authFailures: number[];
}

/**
 * 公网暴露面的第一层防线（spec 第六节）。只按 IP 计数，不认识设备与凭证，
 * 因此不会被伪造的 sid 绕过；上限之外一律拒绝并回 WRONG_PARAM/直接拒绝升级。
 */
export class RelayRateLimiter {
  private readonly states = new Map<string, IpState>();
  private readonly options: RelayRateLimiterOptions;
  private readonly now: () => number;

  constructor(options: RelayRateLimiterOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  admitConnection(ip: string): { ok: true } | { ok: false; reason: string } {
    const state = this.stateOf(ip);
    if (state.connections >= this.options.maxConnectionsPerIp) {
      return { ok: false, reason: "too-many-connections" };
    }
    if (this.recentFailures(state) >= this.options.authFailuresPerWindowPerIp) {
      return { ok: false, reason: "too-many-auth-failures" };
    }
    state.connections += 1;
    return { ok: true };
  }

  releaseConnection(ip: string): void {
    const state = this.states.get(ip);
    if (!state) return;
    state.connections = Math.max(0, state.connections - 1);
  }

  admitRegistration(ip: string): boolean {
    const state = this.stateOf(ip);
    const threshold = this.now() - 60_000;
    state.registrations = state.registrations.filter((timestamp) => timestamp > threshold);
    if (state.registrations.length >= this.options.registrationsPerMinutePerIp) {
      return false;
    }
    state.registrations.push(this.now());
    return true;
  }

  recordAuthFailure(ip: string): void {
    const state = this.stateOf(ip);
    state.authFailures.push(this.now());
  }

  private recentFailures(state: IpState): number {
    const threshold = this.now() - this.options.authFailureWindowMs;
    state.authFailures = state.authFailures.filter((timestamp) => timestamp > threshold);
    return state.authFailures.length;
  }

  private stateOf(ip: string): IpState {
    const existing = this.states.get(ip);
    if (existing) return existing;
    const created: IpState = { connections: 0, registrations: [], authFailures: [] };
    this.states.set(ip, created);
    return created;
  }
}
