const ZCODE_PROCESS_PREFIX = "uwork";
const LEGACY_PROCESS_PREFIX = "zcode";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

/** 崩溃分类与进程命名共用角色边界；兼容升级时仍在运行的旧子进程。 */
export function matchesZCodeProcessRole(name: string | null | undefined): "host" | "agent" | null {
  if (!name) return null;
  for (const prefix of [ZCODE_PROCESS_PREFIX, LEGACY_PROCESS_PREFIX]) {
    for (const role of ["host", "agent"] as const) {
      if (name === `${prefix}-${role}` || name.startsWith(`${prefix}-${role}-`)) return role;
    }
  }
  return null;
}

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinZCodeProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [ZCODE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatZCodeMainProcessName(): string {
  return joinZCodeProcessName("main");
}

export function formatZCodeGpuProcessName(): string {
  return joinZCodeProcessName("gpu");
}

export function formatZCodeHostProcessName(label?: string): string {
  return joinZCodeProcessName("host", label);
}

export function formatZCodeRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "UWork") {
    return joinZCodeProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinZCodeProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "UWork - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinZCodeProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinZCodeProcessName("renderer", normalizedTitle);
}

export function formatZCodeAgentProcessName(provider: string, workspacePath?: string): string {
  return joinZCodeProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatZCodeUtilityProcessName(name?: string, type = "utility"): string {
  return joinZCodeProcessName(type, name);
}
