// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateStatePayload } from "@zcode/shared";
import { WindowsCaptionMenuButton } from "@/WindowsCaptionMenuButton.js";
import { getUpdateMenuLabelId, getUpdateMenuLabelValues } from "@/lib/desktopUpdateMenu.js";

const state = vi.hoisted(() => {
  const base = { canOpenCommunity: vi.fn(async () => false) };
  return {
    capable: true,
    base,
    platform: {
      ...base,
      getUpdateState: vi.fn(),
      onUpdateStateChanged: vi.fn(),
      executeDesktopCommand: vi.fn(async () => {}),
    },
  };
});
vi.mock("@zcode/shared", async (original) => ({
  ...(await original<typeof import("@zcode/shared")>()),
  ZCODE_PRODUCT_FLAVOR: "production",
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => (state.capable ? state.platform : state.base),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({ useShortcutCommandLabel: () => "" }));
vi.mock("@/feedback/feedbackStore.js", () => ({ useFeedbackStore: () => vi.fn() }));
vi.mock("@/components/ui/dropdown-menu.js", () => {
  const Group = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    DropdownMenu: Group,
    DropdownMenuContent: Group,
    DropdownMenuTrigger: Group,
    DropdownMenuCheckboxItem: Group,
    DropdownMenuShortcut: Group,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onSelect?: () => void;
    }) => createElement("button", { disabled, onClick: onSelect }, children),
  };
});
function mount() {
  return render(
    createElement(WindowsCaptionMenuButton, {
      workspaceAbsPath: "/fixture",
      onCreateTask: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onToggleTerminal: vi.fn(),
      onToggleBrowser: vi.fn(),
    }),
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.capable = true;
});

// 修复依据：上游删除旧 hook 后，原 race 用例必须直接覆盖当前菜单，不能丢掉迟到快照防护。
it("实时检查状态不被较晚返回的 idle 快照覆盖，卸载取消订阅", async () => {
  const snapshot = Promise.withResolvers<UpdateStatePayload>();
  let listener!: (state: UpdateStatePayload) => void;
  const dispose = vi.fn();
  state.platform.getUpdateState.mockReturnValue(snapshot.promise);
  state.platform.onUpdateStateChanged.mockImplementation((callback) => {
    listener = callback;
    return dispose;
  });
  const view = mount();
  act(() => listener({ kind: "checking", enabled: false }));
  await act(async () => snapshot.resolve({ kind: "idle", enabled: true }));
  expect(
    screen
      .getByRole("button", { name: "desktopMenu.help.checkingForUpdates" })
      .hasAttribute("disabled"),
  ).toBe(true);
  act(() => listener({ kind: "update-downloaded", enabled: true, version: "3.13.0" }));
  expect(screen.getByRole("button", { name: "desktopMenu.help.restartToUpdate" })).toBeTruthy();
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
});

it("没有 updater 平台能力时不查询或订阅桌面更新状态", async () => {
  state.capable = false;
  await act(async () => {
    mount();
  });
  expect(state.platform.getUpdateState).not.toHaveBeenCalled();
  expect(state.platform.onUpdateStateChanged).not.toHaveBeenCalled();
});

it("可用版本和下载进度沿用原有菜单文案参数", () => {
  const available: UpdateStatePayload = {
    kind: "update-available",
    enabled: true,
    version: "3.13.0",
  };
  const downloading: UpdateStatePayload = {
    kind: "download-progress",
    enabled: true,
    progress: "42%",
  };
  expect(getUpdateMenuLabelId(available)).toBe("desktopMenu.help.updateAvailableVersion");
  expect(getUpdateMenuLabelValues(available)).toEqual({ version: "3.13.0" });
  expect(getUpdateMenuLabelId(downloading)).toBe("desktopMenu.help.downloadingUpdateProgress");
  expect(getUpdateMenuLabelValues(downloading)).toEqual({ progress: "42%" });
});
