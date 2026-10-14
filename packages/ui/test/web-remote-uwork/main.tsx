// 隔离 UI 夹具：使用真实手机壳/身份 Provider，模拟已有 Host 投影，不创建 Agent 或业务运行时。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { EnterpriseIdentityView, WebRemoteControlWorkspaceListResult } from "@zcode/shared";
import { EnterpriseIdentityProvider } from "@/hooks/useEnterpriseIdentity.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";
import { setWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import "@/styles.css";

const counters = {
  reads: 0,
  restores: 0,
  logins: 0,
  gatewaySyncs: 0,
  switches: [] as unknown[],
  selected: [] as unknown[],
};
Object.assign(window, { uworkRemoteUiFixture: counters });
const identityView: EnterpriseIdentityView = {
  revision: 0,
  configured: true,
  organizations: [],
  selectedOrgId: null,
  status: "signed-out",
  profile: null,
  pending: null,
  error: null,
};
const identityService = {
  getView: async () => {
    counters.reads++;
    return identityView;
  },
  restoreSession: async () => {
    counters.restores++;
    return identityView;
  },
  beginLogin: async () => {
    counters.logins++;
    throw new Error("Phone login forbidden");
  },
  onDidChange: () => ({ dispose() {} }),
} as Parameters<typeof EnterpriseIdentityProvider>[0]["service"];
const remoteIdentity = "remote:ssh:fixture:/same/path";
const workspaceList: WebRemoteControlWorkspaceListResult = {
  workspaces: [
    { workspacePath: "/same/path", label: "Local fixture", kind: "local" },
    {
      workspacePath: "/same/path",
      workspaceIdentity: remoteIdentity,
      remoteSessionId: "existing-remote",
      label: "Remote fixture",
      kind: "remote",
      connectionState: "connected",
    },
  ],
  tasks: [
    {
      taskId: "task-a",
      title: "UWORK_TASK_A",
      workspacePath: "/same/path",
      workspaceLabel: "Local fixture",
      workspaceKind: "local",
      createdAt: 1,
      updatedAt: 1,
      provider: "glm",
    },
    {
      taskId: "task-b",
      title: "UWORK_TASK_B",
      workspacePath: "/same/path",
      workspaceIdentity: remoteIdentity,
      remoteSessionId: "existing-remote",
      workspaceLabel: "Remote fixture",
      workspaceKind: "remote",
      createdAt: 2,
      updatedAt: 2,
      provider: "glm",
    },
  ],
};
const broadcastService = { onMessage: () => ({ dispose() {} }), send: async () => {} };
const gatewayService = {
  sync: async () => {
    counters.gatewaySyncs++;
  },
} as unknown as Parameters<typeof EnterpriseIdentityProvider>[0]["ucasGatewayService"];
const providerSettingsService = {
  refresh: async () => ({ revision: 0, providers: [] }),
} as unknown as Parameters<typeof EnterpriseIdentityProvider>[0]["providerSettingsService"];

function Fixture() {
  const [active, setActive] = useState({
    identity: undefined as string | undefined,
    taskId: null as string | null,
    revision: 0,
  });
  const [transportState, setTransportState] = useState<"paired" | "reconnecting">("paired");
  const switcher: WebRemoteControlWorkspaceSwitcherApi = {
    listWorkspaces: async () => workspaceList,
    switchWorkspace: async (workspaceKey, options) => {
      counters.switches.push({ workspaceKey, options });
      setActive((current) => ({
        identity: workspaceKey === remoteIdentity ? remoteIdentity : undefined,
        taskId: options?.taskId ?? null,
        revision: current.revision + 1,
      }));
    },
    updateMobileViewState: async () => {},
  };
  return (
    <PlatformProvider platform={{} as Parameters<typeof PlatformProvider>[0]["platform"]}>
      <StoreProvider broadcastService={broadcastService}>
        <ZCodeIntlProvider initialLocale="en-US">
          <EnterpriseIdentityProvider
            service={identityService}
            providerSettingsService={providerSettingsService}
            ucasGatewayService={gatewayService}
            showOnStartup={false}
            allowLogin={false}
          >
            <div className="flex h-dvh flex-col bg-background text-foreground">
              <button
                onClick={() => {
                  setWebRemoteControlTerminalTransportState("reconnecting");
                  setTransportState("reconnecting");
                }}
              >
                Simulate transport recovery
              </button>
              <WebRemoteControlMobileShell
                key={active.revision}
                switcher={switcher}
                activeWorkspacePath="/same/path"
                activeWorkspaceIdentity={active.identity}
                activeTaskId={active.taskId}
                initialNavigationIntent={active.revision ? "chat" : undefined}
                initialWorkspaceList={workspaceList}
                webRemoteControlTerminalTransportState={transportState}
                onSelectTask={(path, taskId, identity) => {
                  counters.selected.push({ path, taskId, identity });
                  setActive((current) => ({ ...current, taskId }));
                }}
                renderChatHeader={({ onBackHome }) => (
                  <button onClick={onBackHome}>Back to fixture home</button>
                )}
                chatContent={
                  <main
                    data-testid="fixture-chat"
                    data-task-id={active.taskId}
                    data-workspace-identity={active.identity}
                  >
                    Chat {active.taskId}
                  </main>
                }
              />
            </div>
          </EnterpriseIdentityProvider>
        </ZCodeIntlProvider>
      </StoreProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
