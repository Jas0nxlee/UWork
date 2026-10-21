import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";

const triggerCalls = vi.hoisted(() => ({
  /** 每次渲染入口时收到的 props；用来钉住 footer 的透传契约。 */
  props: [] as Record<string, unknown>[],
}));

vi.mock("@/WorkspaceWebRemoteControlTrigger.js", () => ({
  WorkspaceWebRemoteControlTrigger: (props: Record<string, unknown>) => {
    triggerCalls.props.push(props);
    return createElement("button", { "data-testid": "web-remote-control-trigger" });
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: unknown; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    executeDesktopCommand: vi.fn(),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    openExternal: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: { isRestoringOAuthSession: boolean }) => unknown) =>
    selector({ isRestoringOAuthSession: false }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { modelProviderFamilySelectedKeys: {}, providerFamilyDomain: undefined },
    update: vi.fn(),
  }),
}));

function renderFooter(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(WorkspaceSidebarFooter, {
      theme: "dark",
      localeMenuValue: "zh-CN",
      onLocaleChange: () => {},
      onThemeChange: () => {},
      onSettingsButtonClick: () => {},
      ...props,
    } as never),
  );
}

describe("WorkspaceSidebarFooter web remote control entry wiring", () => {
  beforeEach(() => {
    triggerCalls.props = [];
  });

  it("desktop footer 透传远控入口四参", () => {
    const html = renderFooter({
      isDesktop: true,
      workspacePath: "/tmp/project",
      workspaceIdentity: "remote:ssh:host-a",
      workspaceRemoteSessionId: "session-a",
      activeTaskId: "task-a",
    });

    expect(html).toContain('data-testid="web-remote-control-trigger"');
    expect(triggerCalls.props).toEqual([
      {
        workspacePath: "/tmp/project",
        workspaceIdentity: "remote:ssh:host-a",
        remoteSessionId: "session-a",
        initialTaskId: "task-a",
        compact: true,
      },
    ]);
  });

  it("activeTaskId 为空时不把空串当成初始任务", () => {
    renderFooter({
      isDesktop: true,
      workspacePath: "/tmp/project",
      activeTaskId: null,
    });

    expect(triggerCalls.props[0]?.initialTaskId).toBeUndefined();
  });

  it("没有 workspacePath 时不渲染远控入口", () => {
    const html = renderFooter({ isDesktop: true });

    expect(html).not.toContain('data-testid="web-remote-control-trigger"');
    expect(triggerCalls.props).toHaveLength(0);
  });

  it("非桌面窗口（手机远控页自身）不渲染远控入口", () => {
    const html = renderFooter({ isDesktop: false, workspacePath: "/tmp/project" });

    expect(html).not.toContain('data-testid="web-remote-control-trigger"');
    expect(triggerCalls.props).toHaveLength(0);
  });
});
