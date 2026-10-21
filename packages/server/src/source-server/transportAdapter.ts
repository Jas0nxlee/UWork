/* eslint-disable max-lines -- Source Server transport 在同一适配器内汇合安装、daemon、channel 与 target 生命周期，继续拆分会割裂取消边界。 */
import { Duplex } from "node:stream";
import {
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  normalizeRemoteAssetInstallMode,
  sourceServerInstallProgressSchema,
  type SourceServerInstallProgress,
  type PublicZCodeErrorCode,
  type RemoteTarget,
} from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { createRemoteBackend } from "@zcode/server/remote/create-backend.js";
import { detectRemoteTarTool } from "@zcode/server/remote/remoteAssetPreflight.js";
import {
  probeSourceServer,
  SourceServerProbeEnvironmentError,
} from "@zcode/server/source-server/sourceServerProbe.js";
import { buildSourceServerReleaseDownloadCommand } from "@zcode/server/source-server/sourceServerReleaseDownload.js";
import {
  collectCommand,
  duplexFromStdio,
  quoteShellArg,
  readLastJsonLine,
  readStructuredCommandError,
  throwIfAborted,
  type RemoteExecResult,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export type { RemoteExecResult } from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export interface SourceServerProbeResult {
  platform: string;
  arch: string;
  installed: boolean;
  installPath?: string;
  installedVersion?: string;
  installedArchiveSha256?: string;
  daemonStatus?: Record<string, unknown> & { state: string; port?: number };
}

export interface SourceServerProbeOptions {
  includeReleaseIdentity?: boolean;
}

export interface SourceServerIngressInfo {
  port: number;
  ingressToken: string;
}

export interface ServerReleaseAsset {
  localArchivePath?: string;
  target: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  urls: string[];
}

export interface TransportContext {
  signal?: AbortSignal;
  onLog?: (event: {
    phase: string;
    message: string;
    progress?: number;
    level?: "info" | "warn" | "error";
  }) => void;
}

export interface SourceServerInstallOrUpdateOptions {
  force?: boolean;
}

export interface SourceServerEnsureDaemonOptions {
  observedStatus?: SourceServerProbeResult["daemonStatus"];
}

export class SourceServerTransportOperationError extends Error {
  public constructor(
    message: string,
    public readonly code: PublicZCodeErrorCode,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "SourceServerTransportOperationError";
  }
}

export type SourceServerFileTransfer = Pick<IRemoteBackend, "exec" | "upload">;

export interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";
  /** Host 附件暂存复用当前 target 的 transport，不创建另一条远程连接。 */
  createFileTransfer(target: RemoteTarget): SourceServerFileTransfer;
  /** 取消单个连接目标的底层 transport，防止超时 flight 迟到注册为在线 Source。 */
  cancel?(target: RemoteTarget): void;
  probe(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerProbeOptions,
  ): Promise<SourceServerProbeResult>;
  installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options?: SourceServerInstallOrUpdateOptions,
  ): Promise<void>;
  ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerEnsureDaemonOptions,
  ): Promise<SourceServerIngressInfo>;
  openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex>;
  exec(target: RemoteTarget, argv: string[], context: TransportContext): Promise<RemoteExecResult>;
  dispose?(): void;
}

export interface CreateSourceServerTransportAdapterOptions {
  createBackend?: (target: RemoteTarget) => Promise<IRemoteBackend>;
}

// 新安装根 / 旧安装根：`$HOME/.uwork/server` 优先；它不存在而旧 `$HOME/.zcode/server` 存在时
// 继续用旧根（旧安装不迁移、不重装，继续被接管与更新）。
const SERVER_ROOT_READ_PATH = "~/.uwork/server";
const LEGACY_SERVER_ROOT_READ_PATH = "~/.zcode/server";
const SERVER_ROOT_SHELL = '"$HOME/.uwork/server"';
const LEGACY_SERVER_ROOT_SHELL = '"$HOME/.zcode/server"';
/**
 * 远端安装根解析：内联进每条命令，避免为探测多花一次 round-trip。归档内启动器同样双名
 * 兼容（新 `bin/uwork`，旧 `bin/zcode`），旧 archive 安装出来的目录仍可直接被驱动。
 */
const RESOLVE_SERVER_ROOT_SHELL = [
  `SERVER_ROOT=${SERVER_ROOT_SHELL}`,
  `if [ ! -d "$SERVER_ROOT" ] && [ -d ${LEGACY_SERVER_ROOT_SHELL} ]; then SERVER_ROOT=${LEGACY_SERVER_ROOT_SHELL}; fi`,
].join("; ");
const RESOLVE_SERVER_BIN_SHELL = [
  RESOLVE_SERVER_ROOT_SHELL,
  'SERVER_BIN="$SERVER_ROOT/bin/uwork"',
  'if [ ! -f "$SERVER_BIN" ] && [ -f "$SERVER_ROOT/bin/zcode" ]; then SERVER_BIN="$SERVER_ROOT/bin/zcode"; fi',
].join("; ");
const STALE_BOOTSTRAP_AGE_MS = 30 * 60 * 1_000;
const INSTALL_PROGRESS_MESSAGES: Record<SourceServerInstallProgress["phase"], string> = {
  "verify-archive": "Verifying Source Server archive",
  extract: "Extracting Source Server files",
  verify: "Verifying Source Server files",
  restart: "Restarting Source Server",
};

type DirectChannelBackend = IRemoteBackend & {
  openDirectTcpChannel?: (port: number) => Promise<Duplex>;
};

/** 解析远端真正生效的安装根（新根优先，旧根回退）；拿不到绝对路径时 fail-closed，不猜路径。 */
async function resolveRemoteServerRoot(backend: IRemoteBackend): Promise<string> {
  const result = await collectCommand(
    await backend.exec(`${RESOLVE_SERVER_ROOT_SHELL}; printf '%s\\n' "$SERVER_ROOT"`),
  );
  const resolved = (result.stdout.trim().split(/\r?\n/u).pop() ?? "").trim();
  if (result.exitCode !== 0 || !resolved.startsWith("/")) {
    throw new Error(result.stderr.trim() || "Source Server install root could not be resolved");
  }
  return resolved;
}

/**
 * ingress token 属于 daemon 当前使用的安装根：先读新根，读不到再读旧根。
 * 旧安装（只有 `~/.zcode/server`）因此不需要迁移就能继续连接，新装也不会退化。
 */
async function readIngressToken(backend: IRemoteBackend): Promise<string> {
  try {
    return (await backend.readFile(`${SERVER_ROOT_READ_PATH}/run/ingress-token`)).trim();
  } catch (error) {
    const fallback = await backend
      .readFile(`${LEGACY_SERVER_ROOT_READ_PATH}/run/ingress-token`)
      .catch(() => null);
    if (fallback === null) throw error;
    return fallback.trim();
  }
}

class BackendSourceServerTransportAdapter implements SourceServerTransportAdapter {
  private readonly backends = new WeakMap<object, Promise<IRemoteBackend>>();
  private readonly backendPromises = new Set<Promise<IRemoteBackend>>();

  public constructor(
    public readonly kind: "ssh" | "wsl" | "docker",
    private readonly createBackend: (target: RemoteTarget) => Promise<IRemoteBackend>,
  ) {}

  public createFileTransfer(target: RemoteTarget): SourceServerFileTransfer {
    // R3 全转发遗漏了 desktop localPath 的跨机边界；只复用已有 backend 的文件原语。
    const backend = this.getBackend(target);
    return {
      exec: async (command) => (await backend).exec(command),
      upload: async (localPath, remotePath, options) =>
        (await backend).upload(localPath, remotePath, options),
    };
  }

  public async probe(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerProbeOptions = {},
  ): Promise<SourceServerProbeResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    try {
      return await probeSourceServer(backend, context, options);
    } catch (error) {
      // Bug 原因：catch 对所有失败都套 preflight 阶段兜底，握手超时、握手前断开等未识别的
      // 传输失败被报成“设备环境不满足安装要求”；断线恢复耗尽预算时横幅也沿用该误报。
      // 只有远端环境检查本身失败才是预检失败，传输失败识别不了就归入未知。
      const failure = normalizeRemoteConnectionError(
        error,
        error instanceof SourceServerProbeEnvironmentError ? "preflight" : undefined,
      );
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  public async installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions = {},
  ): Promise<void> {
    let phase = "preflight";
    try {
      await this.installRelease(
        target,
        release,
        {
          ...context,
          onLog: (event) => {
            phase = event.phase;
            context.onLog?.(event);
          },
        },
        options,
      );
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  private async installRelease(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions,
  ): Promise<void> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    const operationId = `${process.pid}-${Date.now()}`;
    // upload / remote-download 需要具体路径，bootstrap staging 也必须落在真正生效的安装根里：
    // 在新根不存在而旧根存在（旧安装）时，若把 staging 写到 `~/.uwork/server`，会凭空造出新根，
    // 让后续解析从旧安装跳到空的新目录。先问一次远端，再全部使用解析结果。
    const remoteServerRoot = await resolveRemoteServerRoot(backend);
    const serverRootShell = quoteShellArg(remoteServerRoot);
    const bootstrapRootShell = quoteShellArg(`${remoteServerRoot}/.bootstrap-${operationId}`);
    const bootstrapDirShell = `${bootstrapRootShell}/extract`;
    const remoteArchive = `${remoteServerRoot}/.bootstrap-${operationId}/uwork-server.tar.gz`;
    const remoteArchiveShell = `${bootstrapRootShell}/uwork-server.tar.gz`;
    const cleanupCommand = `rm -rf ${bootstrapRootShell}`;
    const cleanupStaleBootstrapRootsCommand =
      "now_ms=$(($(date +%s) * 1000)); " +
      `for candidate in ${serverRootShell}/.bootstrap-*; do ` +
      '[ -d "$candidate" ] || continue; ' +
      "name=${candidate##*/}; " +
      "created_ms=${name##*-}; " +
      'case "$created_ms" in ""|*[!0-9]*) continue ;; esac; ' +
      "age_ms=$((now_ms - created_ms)); " +
      `[ "$age_ms" -le ${STALE_BOOTSTRAP_AGE_MS} ] || rm -rf -- "$candidate"; ` +
      "done";
    const prepareBootstrapRoot = async (): Promise<void> => {
      const result = await collectCommand(
        await backend.exec(
          // Bug 原因：Controller 在 SFTP/upload 中被强制退出时，JS catch 和远端 EXIT trap
          // 都没有机会运行，Server root 会永久积累数十 MiB 的半包。下次安装只回收带合法
          // epoch 后缀且超过 30 分钟的私有 staging；新鲜并发操作和未知目录一律保留。
          `${cleanupStaleBootstrapRootsCommand} && rm -rf ${bootstrapRootShell} && mkdir -p ${bootstrapRootShell}`,
        ),
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Source Server bootstrap staging failed");
      }
    };
    // Bug 原因：R3 切换完整 archive 后曾无条件走 Desktop upload，SSH 表单保存的
    // remote-download 变成无效选项。这里只分流 archive 获取位置，后续仍汇合到同一 installer。
    const remoteDownload =
      target.kind === "ssh" &&
      normalizeRemoteAssetInstallMode(target.assetInstallMode) === "remote-download" &&
      // Bug 原因：开发态 resolver 已固定本轮本地 archive；若仍按 Profile 偏好直下，
      // bootstrap 产物会被 CDN 同版本 release 替换。显式本地路径拥有更高的制品来源优先级。
      !release.localArchivePath;
    if (remoteDownload) {
      context.onLog?.({
        phase: "download",
        message: `Downloading Source Server ${release.version} on remote host`,
      });
      const downloadCommand = await buildSourceServerReleaseDownloadCommand({
        backend,
        release,
        remoteArchive,
        onLog: (message) => context.onLog?.({ phase: "download", message }),
      });
      await prepareBootstrapRoot();
      const downloadResult = await collectCommand(await backend.exec(downloadCommand), (line) => {
        if (/^download progress:/iu.test(line.trim()))
          context.onLog?.({ phase: "download", message: line.trim() });
      });
      if (downloadResult.exitCode !== 0) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw new Error(
          downloadResult.stderr.trim() || "Remote Source Server archive download failed",
        );
      }
    } else {
      if (!release.localArchivePath) {
        throw new Error("Source Server local archive is unavailable for upload");
      }
      // Bug 原因：本地下载上传路径过去不做 tar preflight，会先传完整 archive，
      // 最后才在远端解压阶段失败；且旧提示错误地建议用户切回同样需要 tar 的本地上传。
      context.onLog?.({
        phase: "preflight",
        message: "Checking remote installation prerequisites",
      });
      await detectRemoteTarTool(backend, {
        log: (message) => context.onLog?.({ phase: "preflight", message: String(message) }),
      });
      await prepareBootstrapRoot();
      context.onLog?.({
        phase: "upload",
        message: `Uploading Source Server ${release.version}`,
      });
      const uploadStartedAt = Date.now();
      try {
        await backend.upload(release.localArchivePath, remoteArchive, {
          signal: context.signal,
          onProgress: ({ uploadedBytes, totalBytes }) =>
            context.onLog?.({
              phase: "upload",
              message: `upload progress: ${(totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0).toFixed(1)}% (${(uploadedBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB, ${(uploadedBytes / 1048576 / Math.max(0.001, (Date.now() - uploadStartedAt) / 1000)).toFixed(2)} MB/s)`,
              progress: totalBytes > 0 ? uploadedBytes / totalBytes : 0,
            }),
        });
      } catch (error) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw error;
      }
    }
    context.onLog?.({ phase: "extract", message: INSTALL_PROGRESS_MESSAGES.extract });
    const command = [
      "set -eu",
      // Bug 原因：running-task guard 让 update 非零退出后，`&& rm` 永远不会执行，远端
      // archive 与 bootstrap staging 会持续残留。EXIT trap 覆盖成功、guard、解压失败和中断。
      `trap ${quoteShellArg(cleanupCommand)} EXIT`,
      // Bug 原因：安全加固/最小服务器常把 /tmp 设为 noexec 或很小的 tmpfs。过去虽把
      // 解压目录移到 Server root，75MB archive 仍先写 /tmp，容量不足时上传到 90% 才
      // EPIPE。archive 与可执行 bootstrap 必须一起位于同一私有 Server staging root。
      `rm -rf ${bootstrapDirShell}`,
      `mkdir -p ${bootstrapDirShell}`,
      `tar -xzf ${remoteArchiveShell} -C ${bootstrapDirShell} --strip-components=1`,
      // 兼容：本轮 archive 的启动器是 bin/uwork；旧 archive（3.16.2 之前）是 bin/zcode。
      `if [ -x ${bootstrapDirShell}/bin/uwork ]; then BOOTSTRAP_BIN=${bootstrapDirShell}/bin/uwork; else BOOTSTRAP_BIN=${bootstrapDirShell}/bin/zcode; fi`,
      // Bug 原因：update 现在会重启完整 daemon；若不把既有 transport 能力边界传给目标
      // bootstrap CLI，WSL/Docker 会在 handoff 时误尝试注册不可用的 systemd user service。
      `${this.kind === "ssh" ? "" : "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "}"$BOOTSTRAP_BIN" update --from-archive ${remoteArchiveShell}${options.force ? " --force" : ""} --server-root ${serverRootShell} --json --progress`,
    ].join(" && ");
    // 上传完成后命令仍需解压、整树校验和 daemon 换代；必须实时消费阶段，不能等退出才显示。
    const result = await collectCommand(await backend.exec(command), (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const event = sourceServerInstallProgressSchema.safeParse(value);
      if (event.success) {
        context.onLog?.({
          phase: event.data.phase,
          message: INSTALL_PROGRESS_MESSAGES[event.data.phase],
        });
      }
    });
    if (result.exitCode !== 0) {
      try {
        const response = readLastJsonLine(result.stdout);
        if (isPublicZCodeErrorCode(response.code)) {
          throw new SourceServerTransportOperationError(
            typeof response.error === "string" && response.error.trim()
              ? response.error
              : "Source Server archive installation failed",
            response.code,
            typeof response.retryable === "boolean" ? response.retryable : undefined,
          );
        }
      } catch (error) {
        if (error instanceof SourceServerTransportOperationError) throw error;
      }
      // Bug 原因：CLI 的 --json 错误写在 stdout，stderr 可能只有 SQLite warning；
      // 安装路径与 daemon 启动复用同一错误解析，避免 warning 覆盖真正的失败原因。
      throw new Error(
        (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
          "Source Server archive installation failed",
      );
    }
    const response = readLastJsonLine(result.stdout);
    if (response.ok === false || response.applied !== true) {
      throw new Error("Source Server archive installation did not apply the release");
    }
    context.onLog?.({
      phase: "install",
      message: `Source Server ${release.version} installed`,
    });
  }

  public async ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerEnsureDaemonOptions = {},
  ): Promise<SourceServerIngressInfo> {
    throwIfAborted(context.signal);
    let status = options.observedStatus;
    const observedReady =
      status?.state === "ready" && Number.isInteger(status.port) && (status.port as number) > 0;
    if (!observedReady) {
      context.onLog?.({ phase: "daemon", message: "Starting Source Server" });
      const result = await this.exec(target, ["serve", "--daemon", "--json"], context);
      if (result.exitCode !== 0) {
        // Bug 原因：Server CLI 的 --json 错误写在 stdout，Node 运行时 warning 写在 stderr。
        // 旧逻辑只取 stderr，最终把 SQLite warning 当成连接根因展示给用户。
        throw new Error(
          (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
            "Source Server daemon failed to start",
        );
      }
      status = readLastJsonLine(result.stdout) as SourceServerProbeResult["daemonStatus"];
    }
    // Bug 原因：probe 刚确认 ready 后仍重复执行 serve --daemon，会多占一个远端 round-trip，
    // 让冷启动在 10 秒预算边缘失败。ready status 只复用端口；ingress token 仍每次重新读取。
    if (!status) throw new Error("Source Server daemon status is unavailable");
    const port = status.port;
    if (!Number.isInteger(port) || (port as number) <= 0) {
      throw new Error("Source Server daemon did not report a valid ingress port");
    }
    if (status.serviceRegistered === false) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server started in detached fallback mode for this remote environment",
      });
    } else if (status.serviceRegistered === true) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server registered with the remote OS user service manager",
      });
    }
    const backend = await this.getBackend(target);
    const ingressToken = await readIngressToken(backend);
    if (!ingressToken) throw new Error("Source Server ingress token is missing");
    return { port: port as number, ingressToken };
  }

  public async openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex> {
    throwIfAborted(context.signal);
    const backend = (await this.getBackend(target)) as DirectChannelBackend;
    if (this.kind === "ssh" && backend.openDirectTcpChannel) {
      try {
        return await backend.openDirectTcpChannel(ingress.port);
      } catch (error) {
        context.onLog?.({
          phase: "channel",
          message: `SSH direct-tcpip unavailable; using proxy-stdio (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }
    return duplexFromStdio(
      await backend.exec(
        `${RESOLVE_SERVER_BIN_SHELL}; "$SERVER_BIN" server proxy-stdio --server-root "$SERVER_ROOT"`,
      ),
    );
  }

  public async exec(
    target: RemoteTarget,
    argv: string[],
    context: TransportContext,
  ): Promise<RemoteExecResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    const hasServerRoot = argv.includes("--server-root");
    const daemonEnvironment =
      this.kind !== "ssh" && argv[0] === "serve" && argv.includes("--daemon")
        ? "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "
        : "";
    const command = [
      // Bug 原因：WSL/Docker 没有稳定的用户级服务管理器；若沿用 SSH 命令会尝试
      // 注册 systemd user service 并在常见环境中失败。两者必须显式进入 detached fallback。
      `${RESOLVE_SERVER_BIN_SHELL}; ${daemonEnvironment}"$SERVER_BIN"`,
      ...argv.map(quoteShellArg),
      ...(hasServerRoot ? [] : ["--server-root", '"$SERVER_ROOT"']),
    ].join(" ");
    return await collectCommand(await backend.exec(command));
  }

  public dispose(): void {
    for (const backend of this.backendPromises) {
      void backend.then(
        (resolved) => resolved.dispose(),
        () => undefined,
      );
    }
    this.backendPromises.clear();
  }

  public cancel(target: RemoteTarget): void {
    if (target.kind !== this.kind) return;
    const key = target as object;
    const backend = this.backends.get(key);
    if (!backend) return;
    // Bug 原因：启动 10 秒超时过去只 reject 外层 Promise，SSH 握手仍在后台继续，
    // 迟到后会把 Source 注册 online。精确摘除本 target backend，后续手动重试可新建 transport。
    this.backends.delete(key);
    this.backendPromises.delete(backend);
    void backend.then(
      (resolved) => resolved.dispose(),
      () => undefined,
    );
  }

  private async getBackend(target: RemoteTarget): Promise<IRemoteBackend> {
    if (target.kind !== this.kind) {
      throw new Error(`Transport ${this.kind} cannot handle target ${target.kind}`);
    }
    const key = target as object;
    let backend = this.backends.get(key);
    if (!backend) {
      backend = this.createBackend(target);
      this.backends.set(key, backend);
      this.backendPromises.add(backend);
    }
    return await backend;
  }
}

export function createSourceServerTransportAdapter(
  kind: "ssh" | "wsl" | "docker",
  options: CreateSourceServerTransportAdapterOptions = {},
): SourceServerTransportAdapter {
  return new BackendSourceServerTransportAdapter(
    kind,
    options.createBackend ?? createRemoteBackend,
  );
}
