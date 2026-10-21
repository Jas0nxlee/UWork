import { updatePreparationResultSchema } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { isAbsolute } from "node:path";
import { currentServerTarget } from "./manifest.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { ReleaseManager } from "./releaseManager.js";
import {
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  type SourceServerInstallProgress,
} from "@zcode/shared";
import { ControlRequestError } from "../ipc/controlError.js";
import type { ReleaseManifest } from "../contracts.js";

interface UpdateCliIO {
  stdout?: { write(value: string): void };
}

export interface UpdateDaemonHandoff {
  converge(input: {
    layout: ServerLayout;
    previous: ReleaseManifest | null;
    target: ReleaseManifest;
  }): Promise<void>;
}

function readSingleOption(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function isControlEndpointUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL")
  );
}

function stdout(io: UpdateCliIO, value: unknown): void {
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function createRunningTaskUpdateGuard(): ControlRequestError {
  return new ControlRequestError(
    SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
    "Running tasks require --force for update",
    false,
  );
}

export async function runLocalArchiveUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<unknown>,
  updateDaemonHandoff?: UpdateDaemonHandoff,
): Promise<number> {
  const archivePath = readSingleOption(argv, "--from-archive");
  if (!archivePath) throw new Error("--from-archive requires a path");
  if (!isAbsolute(archivePath)) throw new Error("--from-archive must be an absolute path");
  const force = argv.includes("--force");
  const onProgress = (phase: SourceServerInstallProgress["phase"]): void => {
    if (json && argv.includes("--progress")) {
      stdout(io, {
        type: "source-server-install-progress",
        phase,
      } satisfies SourceServerInstallProgress);
    }
  };
  let daemonOnline = false;
  if (!force) {
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      daemonOnline = true;
      if (result.status === "blocked") throw createRunningTaskUpdateGuard();
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  } else {
    try {
      await requestControl(layout.controlEndpoint, { command: "status" });
      daemonOnline = true;
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  }
  const releaseManager = new ReleaseManager(layout);
  const previous = await releaseManager.readCurrent();
  const prepared = await new ReleaseInstaller(layout).installArchive({
    archivePath,
    target: currentServerTarget(),
    onProgress,
  });
  if (daemonOnline) {
    if (!force) {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") throw createRunningTaskUpdateGuard();
    }
    onProgress("restart");
    await applyUpdate();
    await updateDaemonHandoff?.converge({ layout, previous, target: prepared });
    const result = { applied: true, installed: false, version: prepared.version };
    if (json) stdout(io, result);
    else stdout(io, `UWork Server ${prepared.version} updated`);
    return 0;
  }
  await releaseManager.applyPendingWithTransaction(previous);
  await releaseManager.completeUpdate();
  const result = { applied: true, installed: previous === null, version: prepared.version };
  if (json) stdout(io, result);
  else stdout(io, `UWork Server ${prepared.version} ${previous ? "updated" : "installed"}`);
  return 0;
}
