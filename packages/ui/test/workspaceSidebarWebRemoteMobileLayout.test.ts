// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectSidebarProps,
  ProjectTree,
  RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
const Sidebar = (props: ProjectSidebarProps) =>
  createElement(
    TooltipProvider,
    null,
    createElement(
      ProjectDirectoryProvider,
      { isDesktop: props.isDesktop },
      createElement(WorkspaceSidebar, props),
    ),
  );

const fixture = vi.hoisted(() => {
  const state = { tabs: [], activeWorkspaceIdentity: null, openSettingsTab: vi.fn() };
  return {
    state,
    local: { projects: [], tasks: [] } as ProjectTree,
    remote: { projects: [], tasks: [] } as ProjectTree,
    directory: { hosts: [], entries: [] } as RemoteProjectDirectory,
    sourceManagement: vi.fn(async () => ({ servers: [], profiles: [], states: [] })),
    connectHost: vi.fn(),
    removeHost: vi.fn(),
    removeEntry: vi.fn(),
    openUpgrade: vi.fn(),
  };
});
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  const base = {
    sourceServerManagementService: {
      getSnapshot: fixture.sourceManagement,
      onDidChangeState: () => ({ dispose() {} }),
    },
    projectService: {
      // 真实离线 Host 没有在线 source，readTree 会失败；夹具按连接状态模拟，避免离线行仍被判为可编辑。
      readTree: async (params?: { hostId?: string }) => {
        if (!params?.hostId) return fixture.local;
        if (
          fixture.directory.hosts.some(
            (host) => host.id === params.hostId && host.connectionStatus !== "online",
          )
        )
          throw new Error("project.host-offline");
        return fixture.remote;
      },
    },
    remoteProjectService: {
      readDirectory: async () => fixture.directory,
      refreshEntry: async () => true,
      connectHost: fixture.connectHost,
      removeHost: fixture.removeHost,
      removeEntry: fixture.removeEntry,
    },
    zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose: vi.fn() }) },
    broadcastService: { onMessage: () => ({ dispose: vi.fn() }) },
  };
  return { useBaseWorkspaceServices: () => base };
});
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  useOptionalTabStore: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  // 项目目录的未读监听使用原 store 的订阅接口，布局夹具也需提供可释放的订阅。
  useTabStoreApi: () => ({ getState: () => fixture.state, subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
    {
      subscribe: () => () => {},
      // 新建在点击时读取组织上下文，不再订阅本地活动任务。
      getState: () => ({ getWorkspaceState: () => ({ activeTaskId: null }) }),
    },
  ),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: () => true,
  useZCodeStore: (selector: (state: unknown) => unknown) => selector({ setTheme: vi.fn() }),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    localePreference: "en-US",
    setLocalePreference: vi.fn(),
  }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
vi.mock("@/hooks/usePlatform.js", () => ({
  useSelectDirectory: () => vi.fn(),
  useOptionalPlatform: () => null,
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: fixture.openUpgrade }),
}));
vi.mock("@/components/manual-claim-plan/ManualClaimPlanBanner.js", () => ({
  ManualClaimPlanBanner: () => null,
}));
// UWork：footer 的远控参数（workspaceIdentity / 远控 session）必须原样转发；
// 上游把 footer mock 成纯文本，这里额外记录实参，供定制用例断言。
const sidebarFooterProps = vi.hoisted(() => vi.fn());
vi.mock("@/WorkspaceSidebarFooter.js", () => ({
  WorkspaceSidebarFooter: (props: Record<string, unknown>) => {
    sidebarFooterProps(props);
    return createElement("footer", {}, "Footer");
  },
}));
vi.mock("@/NewTaskButtonGroup.js", () => ({
  NewTaskButtonGroup: ({ onCreateTask }: { onCreateTask(): void }) =>
    createElement("button", { onClick: onCreateTask }, "New task"),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
vi.mock("@/project-sidebar/useProjectTaskNavigation.js", () => ({
  useProjectTaskNavigation: (props: ProjectSidebarProps) => props.onSelectTask,
}));

function props(overrides: Partial<ProjectSidebarProps> = {}): ProjectSidebarProps {
  return {
    workspacePath: "/local",
    theme: "light",
    onSelectTask: vi.fn(),
    onCreateTask: vi.fn(),
    onCreateConversationTask: vi.fn(),
    onStartDraftInWorkspace: vi.fn(),
    onOpenFolderFromWorkspaceMenu: vi.fn(),
    onConnectRemote: vi.fn(async () => "logical"),
    onSelectRemoteProject: vi.fn(async () => {}),
    onCancelRemoteProject: vi.fn(async () => {}),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    reconnectingRemoteWorkspaceKeys: [],
    remoteWorkspaceErrorByWorkspaceKey: {},
    onOpenCommandCenter: vi.fn(),
    ...overrides,
  };
}
function remoteHost(online: boolean) {
  fixture.remote = {
    projects: [
      {
        id: "p",
        hostId: "remote:server:s",
        name: "Remote project",
        roots: [],
        position: 1,
        pinned: false,
        deleted: false,
        nameOverridden: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tasks: [],
  };
  fixture.directory = {
    hosts: [
      {
        id: "remote:server:s",
        membershipId: "m",
        kind: "docker",
        target: { kind: "docker", container: "dev" },
        position: 1,
        connectionStatus: online ? "online" : "offline",
      },
    ],
    entries: [
      {
        id: "entry",
        hostId: "remote:server:s",
        projectId: "p",
        name: "Remote project",
        roots: [],
        legacyWorkspace: null,
        lastSyncedAt: 1,
      },
    ],
  };
}
beforeEach(() => {
  fixture.local = { projects: [], tasks: [] };
  fixture.remote = { projects: [], tasks: [] };
  fixture.directory = { hosts: [], entries: [] };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("virtual-project sidebar on desktop and mobile", () => {
  it("reads the Controller project contract without calling the desktop-only Source management channel", async () => {
    render(createElement(Sidebar, props({ isWebRemoteControl: true })));
    await waitFor(() => expect(screen.queryByText("common.loading")).toBeNull());
    expect(fixture.sourceManagement).not.toHaveBeenCalled();
  });
  it("keeps plugin navigation immediately after automations and calls the selected destination", () => {
    const onOpenPluginStore = vi.fn();
    render(
      createElement(
        Sidebar,
        props({ isDesktop: true, onOpenAutomations: vi.fn(), onOpenPluginStore }),
      ),
    );
    const scheduled = screen.getByText("workspace.openScheduledSettings");
    const plugins = screen.getByText("workspace.openPluginsSettings");
    expect(
      scheduled.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(plugins);
    expect(onOpenPluginStore).toHaveBeenCalledOnce();
  });
  it("inherits current organization at the top entry and keeps section new-task unclassified", () => {
    const onCreateTask = vi.fn();
    render(createElement(Sidebar, props({ onCreateTask })));
    fireEvent.click(screen.getByText("New task"));
    expect(onCreateTask).toHaveBeenNthCalledWith(1);
    fireEvent.click(screen.getByTestId("virtual-project-new-task"));
    expect(onCreateTask).toHaveBeenNthCalledWith(2, { projectId: null, taskGroupId: null });
  });
  it("shows the Relay V2 device header only when the remote switcher provides device navigation", async () => {
    const chooseOtherDevice = vi.fn();
    const switcher = {
      listWorkspaces: vi.fn(),
      switchWorkspace: vi.fn(),
      deviceNavigation: { deviceName: "Mac", chooseOtherDevice },
    } as unknown as NonNullable<ProjectSidebarProps["webRemoteControlWorkspaceSwitcher"]>;
    const { unmount } = render(
      createElement(
        Sidebar,
        props({ isWebRemoteControl: true, webRemoteControlWorkspaceSwitcher: switcher }),
      ),
    );
    const device = screen.getByRole("button", { name: "webRemoteControl.switchDevice" });
    const navigation = screen.getByTestId("sidebar-primary-navigation");
    // 设备行是导航首行：位于“新建任务”之上。
    expect(navigation.firstElementChild).toBe(device);
    expect(
      device.compareDocumentPosition(screen.getByText("New task")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(device);
    expect(chooseOtherDevice).toHaveBeenCalledOnce();
    unmount();

    render(createElement(Sidebar, props({ isWebRemoteControl: true })));
    await waitFor(() => expect(screen.queryByText("common.loading")).toBeNull());
    expect(screen.queryByRole("button", { name: "webRemoteControl.switchDevice" })).toBeNull();
  });
  it("routes a retained remote project's new task to that Host", async () => {
    remoteHost(true);
    const onCreateTask = vi.fn();
    render(createElement(Sidebar, props({ onCreateTask })));
    const project = await screen.findByText("Remote project");
    const section = project.closest("[data-project-id]") as HTMLElement;
    fireEvent.click(within(section).getByTestId("virtual-project-create-task"));
    expect(onCreateTask).toHaveBeenCalledWith({
      hostId: "remote:server:s",
      projectId: "p",
      taskGroupId: null,
    });
    expect(fixture.sourceManagement).not.toHaveBeenCalled();
  });
  it("connects a retained Host through the narrow connection port", async () => {
    remoteHost(false);
    render(createElement(Sidebar, props()));
    await screen.findByText("Remote project");
    fireEvent.keyDown(screen.getByTestId("virtual-project-menu"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "project.connect" }));
    await waitFor(() => expect(fixture.connectHost).toHaveBeenCalledWith("remote:server:s"));
    expect(fixture.sourceManagement).not.toHaveBeenCalled();
  });
  it("keeps an online remote project menu aligned with local projects", async () => {
    remoteHost(true);
    render(createElement(Sidebar, props()));
    await screen.findByText("Remote project");
    fireEvent.keyDown(screen.getByTestId("virtual-project-menu"), { key: "ArrowDown" });
    await screen.findByRole("menuitem", { name: "project.delete" });
    expect(screen.queryByRole("menuitem", { name: "project.removeEntry" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "project.addRemoteProject" })).toBeNull();
  });
  it("removes only the offline project entry without removing its Host", async () => {
    remoteHost(false);
    render(createElement(Sidebar, props()));
    await screen.findByText("Remote project");
    fireEvent.keyDown(screen.getByTestId("virtual-project-menu"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "project.removeEntry" }));
    await waitFor(() => expect(fixture.removeEntry).toHaveBeenCalledWith("entry"));
    expect(fixture.removeHost).not.toHaveBeenCalled();
    expect(fixture.sourceManagement).not.toHaveBeenCalled();
  });

  // UWork 定制：项目侧栏不再从 tab 反推身份，远控入口必须沿用当前 attachment 的精确 scope。
  it("forwards the remote workspace identity and live session into the footer entry", () => {
    render(
      createElement(
        Sidebar,
        props({
          isDesktop: true,
          workspaceIdentity: "remote:ssh:host-a",
          workspaceRemoteSessionId: "session-a",
        }),
      ),
    );

    expect(sidebarFooterProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isDesktop: true,
        workspacePath: "/local",
        workspaceIdentity: "remote:ssh:host-a",
        workspaceRemoteSessionId: "session-a",
      }),
    );
  });
  it("keeps the remote entry params unset for a plain local workspace", () => {
    render(createElement(Sidebar, props({ isDesktop: true })));

    const footerProps = sidebarFooterProps.mock.lastCall?.[0] as Record<string, unknown>;
    expect(footerProps.isDesktop).toBe(true);
    expect(footerProps.workspacePath).toBe("/local");
    expect(footerProps.workspaceRemoteSessionId).toBeUndefined();
    expect(footerProps.workspaceIdentity).toBeUndefined();
  });
  // D37：手机 /remote 的导航与任务列表共用一个滚动面板，且不承载 Automations；
  // 合并上游后不能把桌面入口重新带进手机侧栏。
  it("keeps one mobile scroll panel for navigation and tasks without automations", async () => {
    const switcher = {
      listWorkspaces: vi.fn(),
      switchWorkspace: vi.fn(),
    } as unknown as NonNullable<ProjectSidebarProps["webRemoteControlWorkspaceSwitcher"]>;
    const { container } = render(
      createElement(
        Sidebar,
        props({ isWebRemoteControl: true, webRemoteControlWorkspaceSwitcher: switcher }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("common.loading")).toBeNull());

    const panel = container.querySelector('[data-project-sidebar-panel="navigation"]');
    expect(panel).not.toBeNull();
    const scope = within(panel as HTMLElement);
    expect(scope.getByTestId("sidebar-primary-navigation")).toBeTruthy();
    expect(scope.getByTestId("sidebar-task-list-region")).toBeTruthy();
    // Automations 入口由 Shell 决定是否下发；手机 /remote 不下发，侧栏也不得自己补回。
    expect(scope.queryByText("workspace.openScheduledSettings")).toBeNull();
  });

  // TODO(uwork-merge): 原文件的这几条 UWork 定制断言挂在旧的 WorkspaceSidebar 单体实现上，
  //    按上游 project-sidebar 新结构重写时无法原样表达，等 WorkspaceSidebar.tsx 的冲突定案后重新落位：
  //      1. WebRemoteControlTaskIndex 的 props 转发（switcher / onWebRemoteTaskOpen /
  //         onWebRemoteTaskSwitchingChange 的 true→false 生命周期）——上游新结构不渲染该组件。
  //      2. 手机远控的单一滚动区标记（data-web-remote-navigation-scroll / max-md:overflow-y-auto）。
  //      3. 归档视图打开后关闭按钮 tooltip 切到 common.close，以及任务工具栏搜索状态已移除的源码守卫。
});
