import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";
import { TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER } from "@zcode/shared/test-ids";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

const captured = vi.hoisted(() => ({
  zsrcUrl: null as string | null,
  loading: false,
  openExternal: vi.fn(),
  exportLogs: vi.fn(async () => ({ success: true })),
  toast: vi.fn(() => 7),
  dismissToast: vi.fn(),
  menuItems: [] as Array<{
    label: string;
    testId?: string;
    disabled?: boolean;
    onSelect: (() => void | Promise<void>) | undefined;
  }>,
  updateMenu: {
    visible: true,
    disabled: false,
    labelId: "titleBar.menu.help.checkForUpdates",
    labelValues: undefined,
  },
  executeDesktopCommand: vi.fn(async () => undefined),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void | Promise<void>;
    disabled?: boolean;
    "data-testid"?: string;
  }) => {
    const label = Array.isArray(children)
      ? children.filter((child) => typeof child === "string").join("")
      : typeof children === "string"
        ? children
        : "";
    captured.menuItems.push({ label, testId, onSelect, disabled });
    return createElement("div", { "data-testid": testId }, children);
  },
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: captured.toast,
  dismissToast: captured.dismissToast,
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      openSubmit: (draft?: unknown) => void;
      openFeatureRequest: () => void;
    }) => unknown,
  ) => selector({ openSubmit: vi.fn(), openFeatureRequest: vi.fn() }),
}));

vi.mock("@/hooks/useDesktopUpdateMenu.js", () => ({
  useDesktopUpdateMenu: (isDesktop: boolean) => ({
    ...captured.updateMenu,
    visible: isDesktop && captured.updateMenu.visible,
    checkForUpdates: () => captured.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    captureWindowScreenshot: vi.fn(async () => null),
    executeDesktopCommand: captured.executeDesktopCommand,
    exportLogs: captured.exportLogs,
    openCommunity: vi.fn(async () => undefined),
    openExternal: captured.openExternal,
  }),
}));

vi.mock("@/hooks/useVulnerabilityReportUrl.js", () => ({
  useVulnerabilityReportUrl: () => ({ url: captured.zsrcUrl, loading: captured.loading }),
}));

describe("WorkspaceHelpMenuButton", () => {
  async function render(isDesktop: boolean | undefined) {
    captured.menuItems = [];
    captured.executeDesktopCommand.mockClear();
    captured.exportLogs.mockClear();
    captured.toast.mockClear();
    captured.dismissToast.mockClear();
    const { WorkspaceHelpMenuButton } = await import("@/WorkspaceHelpMenuButton.js");
    return renderToStaticMarkup(createElement(WorkspaceHelpMenuButton, { isDesktop }));
  }

  it("已配置漏洞地址也不恢复已裁剪入口", async () => {
    captured.zsrcUrl = "https://security.example.test/report";
    try {
      for (const desktop of [true, false]) {
        const html = await render(desktop);
        expect(html).not.toContain("workspaceHeader.help.reportVulnerability");
        expect(captured.menuItems).toHaveLength(desktop ? 1 : 0);
        if (desktop) await captured.menuItems[0]!.onSelect?.();
        expect(captured.openExternal).not.toHaveBeenCalled();
      }
    } finally {
      captured.zsrcUrl = null;
    }
  });

  it("旧漏洞配置从加载到可用都不会改变唯一菜单项", async () => {
    captured.loading = true;
    captured.openExternal.mockClear();
    try {
      await render(true);
      const before = captured.menuItems.map((item) => item.label);
      captured.loading = false;
      captured.zsrcUrl = "https://security.example.test/report";
      await render(true);
      expect(captured.menuItems.map((item) => item.label)).toEqual(before);
      expect(before).toEqual(["titleBar.menu.help.resourceManager"]);
      expect(captured.menuItems[0]!.onSelect).toBeTypeOf("function");
      await captured.menuItems[0]!.onSelect?.();
      expect(captured.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
        DesktopCommandIds.OpenResourceManager,
      );
      expect(captured.openExternal).not.toHaveBeenCalled();
    } finally {
      captured.loading = false;
      captured.zsrcUrl = null;
    }
  });

  it("桌面端渲染资源管理器项，点击走 OpenResourceManager 命令", async () => {
    // 原因：Windows/Linux 没有原生菜单栏，自绘箭头菜单也已下线，问号菜单是资源管理器唯一入口。
    const html = await render(true);

    expect(html).toContain("titleBar.menu.help.resourceManager");
    const item = captured.menuItems.find(
      (entry) => entry.testId === TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
    );
    expect(item).toBeDefined();
    await item!.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.OpenResourceManager,
    );
  });

  it("Web 端（isDesktop 缺省 / false）不渲染资源管理器项", async () => {
    for (const isDesktop of [undefined, false]) {
      const html = await render(isDesktop);
      expect(html).not.toContain("titleBar.menu.help.resourceManager");
      expect(
        captured.menuItems.some(
          (entry) => entry.testId === TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
        ),
      ).toBe(false);
    }
  });

  it("桌面不恢复关于动作，唯一动作仍是资源管理器", async () => {
    expect(await render(true)).not.toContain("titleBar.menu.help.about");
    expect(captured.menuItems).toHaveLength(1);
    await captured.menuItems[0]!.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
      DesktopCommandIds.OpenResourceManager,
    );
    expect(captured.executeDesktopCommand).not.toHaveBeenCalledWith(DesktopCommandIds.ShowAbout);
  });

  it("Web 和手机远控不显示桌面关于入口", async () => {
    for (const isDesktop of [undefined, false]) {
      expect(await render(isDesktop)).not.toContain("titleBar.menu.help.about");
    }
  });

  it("旧更新状态可用时也不恢复检查更新动作", async () => {
    expect(await render(true)).not.toContain("titleBar.menu.help.checkForUpdates");
    expect(captured.menuItems).toHaveLength(1);
    await captured.menuItems[0]!.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
      DesktopCommandIds.OpenResourceManager,
    );
    expect(captured.executeDesktopCommand).not.toHaveBeenCalledWith(
      DesktopCommandIds.CheckForUpdates,
    );
  });

  it("Web 与 Preview 不显示检查更新", async () => {
    expect(await render(false)).not.toContain("titleBar.menu.help.checkForUpdates");
    captured.updateMenu.visible = false;
    try {
      expect(await render(true)).not.toContain("titleBar.menu.help.checkForUpdates");
    } finally {
      captured.updateMenu.visible = true;
    }
  });

  it("桌面菜单不触发已裁剪的导出日志及提示", async () => {
    expect(await render(true)).not.toContain("titleBar.menu.help.exportLogs");
    expect(captured.menuItems).toHaveLength(1);
    await captured.menuItems[0]!.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
      DesktopCommandIds.OpenResourceManager,
    );
    expect(captured.exportLogs).not.toHaveBeenCalled();
    expect(captured.toast).not.toHaveBeenCalled();
    expect(captured.dismissToast).not.toHaveBeenCalled();
  });

  it("Web 和手机远控不显示本地导出日志入口", async () => {
    for (const isDesktop of [undefined, false]) {
      expect(await render(isDesktop)).not.toContain("titleBar.menu.help.exportLogs");
      expect(captured.exportLogs).not.toHaveBeenCalled();
    }
  });

  it("桌面仅一项且没有分隔线，Web 不留空菜单", async () => {
    for (const desktop of [true, false]) {
      const html = await render(desktop);
      expect(captured.menuItems.map((item) => item.label)).toEqual(
        desktop ? ["titleBar.menu.help.resourceManager"] : [],
      );
      expect(html).not.toContain("<hr");
      if (!desktop) expect(html).toBe("");
    }
  });

  it("桌面按钮可访问，已裁剪外链与 Web 按钮都不恢复", async () => {
    const html = await render(true);
    expect(html).toContain('aria-label="workspaceHeader.help.menu"');
    for (const id of ["issueReport", "productRequest", "community", "docs"])
      expect(html).not.toContain(`workspaceHeader.help.${id}`);
    await captured.menuItems[0]!.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
      DesktopCommandIds.OpenResourceManager,
    );
    expect(captured.openExternal).not.toHaveBeenCalled();
    expect(await render(false)).toBe("");
    expect(captured.menuItems).toEqual([]);
  });
});
