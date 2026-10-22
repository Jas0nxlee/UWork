// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ImDirectoryUser, ImMember } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImMemberPanel } from "@/im/ImMemberPanel.js";
import { describeSystemMessage } from "@/im/imSystemMessage.js";

const directory: ImDirectoryUser[] = [
  {
    id: "u-a",
    name: "吴鹏",
    avatar: null,
    department: "测试与服务保障部",
    departments: ["测试与服务保障部"],
    position: null,
  },
  {
    id: "u-b",
    name: "吕岳阳",
    avatar: null,
    department: "算力服务事业部",
    departments: ["算力服务事业部"],
    position: null,
  },
];

const member = (over: Partial<ImMember> = {}): ImMember => ({
  id: "u-a",
  role: "member",
  joinedAt: 0,
  online: false,
  ...over,
});

const renderPanel = (members: ImMember[], onOpenSettings?: () => void) =>
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImMemberPanel, { members, directory, selfUserId: "u-b", onOpenSettings }),
    ),
  );

afterEach(cleanup);

describe("成员面板", () => {
  it("按在线/离线分组，组标题带人数", () => {
    const { container } = renderPanel([
      member({ id: "u-a", online: true }),
      member({ id: "u-b", online: false }),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("在线 — 1");
    expect(text).toContain("离线 — 1");
    expect(container.querySelectorAll('[data-testid="im-member-row"]')).toHaveLength(2);
  });

  it("只给在线成员画状态点（离线不画，不猜）", () => {
    const { container } = renderPanel([
      member({ id: "u-a", online: true }),
      member({ id: "u-b", online: false }),
    ]);
    expect(container.querySelectorAll('[data-testid="im-member-online"]')).toHaveLength(1);
  });

  it("显示自己为「你」，并标出群主", () => {
    const { container } = renderPanel([member({ id: "u-b", role: "owner", online: true })]);
    expect(container.textContent).toContain("你");
    expect(container.textContent).toContain("群主");
  });

  it("有设置入口时才渲染齿轮按钮", () => {
    const onOpenSettings = vi.fn();
    const { container, unmount } = renderPanel([member()], onOpenSettings);
    const gear = container.querySelector('button[aria-label="群设置"]') as HTMLButtonElement;
    expect(gear).not.toBeNull();
    gear.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    unmount();

    const without = renderPanel([member()]);
    expect(without.container.querySelector('button[aria-label="群设置"]')).toBeNull();
  });
});

describe("系统消息文案", () => {
  const t = (id: string, values?: Record<string, string | number>): string => {
    const templates: Record<string, string> = {
      "im.system.groupCreated": "{actor} 创建了群「{title}」",
      "im.system.membersAdded": "{actor} 添加了 {names}",
      "im.system.memberRemoved": "{actor} 移出了 {name}",
      "im.system.memberLeft": "{actor} 退出了群聊",
      "im.system.titleChanged": "{actor} 把群名改成了「{title}」",
      "im.system.unsupported": "群信息有更新",
      "common.listSeparator": "、",
    };
    const template = templates[id] ?? id;
    return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? ""));
  };
  const nameOf = (id: string): string | undefined =>
    ({ "u-a": "吴鹏", "u-b": "吕岳阳" })[id as "u-a"];

  it("把载荷渲染成人话", () => {
    expect(
      describeSystemMessage(
        JSON.stringify({ action: "group_created", actorId: "u-a", title: "测试小组" }),
        nameOf,
        t,
      ).text,
    ).toBe("吴鹏 创建了群「测试小组」");
    expect(
      describeSystemMessage(
        JSON.stringify({ action: "members_added", actorId: "u-a", memberIds: ["u-b"] }),
        nameOf,
        t,
      ).text,
    ).toBe("吴鹏 添加了 吕岳阳");
  });

  it("被移出与主动退群是两句不同文案", () => {
    expect(
      describeSystemMessage(
        JSON.stringify({ action: "member_removed", actorId: "u-a", memberId: "u-b" }),
        nameOf,
        t,
      ).text,
    ).toBe("吴鹏 移出了 吕岳阳");
    expect(
      describeSystemMessage(
        JSON.stringify({ action: "member_removed", actorId: "u-b", memberId: "u-b" }),
        nameOf,
        t,
      ).text,
    ).toBe("吕岳阳 退出了群聊");
  });

  it("载荷认不出或动作不认识时不把 JSON 甩给用户", () => {
    expect(describeSystemMessage("not-json", nameOf, t).text).toBe("not-json");
    expect(describeSystemMessage(JSON.stringify({ action: "future_action" }), nameOf, t).text).toBe(
      "群信息有更新",
    );
  });
});
