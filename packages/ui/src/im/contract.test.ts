import { describe, expect, it } from "vitest";
import { isSidePaneTabVisibleInScope } from "@/lib/workspaceSidePane.js";
import { exampleMessagesPaneProps } from "./contract.example.js";

describe("IM 面板宿主契约", () => {
  it("同工作区切换任务时保留应用级消息面板", () => {
    const { tab } = exampleMessagesPaneProps("/workspace", "workspace-a");
    expect(
      isSidePaneTabVisibleInScope(tab, { workspaceKey: "workspace-a", ownerTaskId: "a" }),
    ).toBe(true);
    expect(
      isSidePaneTabVisibleInScope(tab, { workspaceKey: "workspace-a", ownerTaskId: "b" }),
    ).toBe(true);
  });

  it("路径相同也不能把不同 workspace 的消息面板混用", () => {
    const a = exampleMessagesPaneProps("/workspace", "workspace-a");
    const b = exampleMessagesPaneProps("/workspace", "workspace-b");
    expect(a.tab.id).not.toBe(b.tab.id);
    expect(
      isSidePaneTabVisibleInScope(a.tab, { workspaceKey: "workspace-b", ownerTaskId: null }),
    ).toBe(false);
  });
});
