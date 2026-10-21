// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImDirectoryUser } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImDirectoryList } from "@/im/ImDirectoryList.js";

/**
 * 通讯录分栏的折叠。
 *
 * 三条要钉住的：① 点栏头收起/展开；② **搜索时强制展开**（否则"人搜到了却藏在折叠栏里"）；
 * ③ 折叠偏好要持久化（换个会话回来还是收着）。jsdom 的 localStorage 是残缺桩，测试内自己桩一份。
 */
const person = (id: string, name: string, departments: string[]): ImDirectoryUser => ({
  id,
  name,
  avatar: null,
  department: departments.join(", ") || null,
  departments,
  position: "测试工程师",
});

const users: ImDirectoryUser[] = [
  person("u-1", "蔡丽涛", ["测试与服务保障部"]),
  person("u-2", "陈瀚霖", ["测试与服务保障部"]),
  person("u-3", "吕岳阳", ["算力服务器事业部"]),
];

const renderList = () =>
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImDirectoryList, { users, onPick: vi.fn() }),
    ),
  );

const rowsFor = (title: string): number => {
  const sections = [...document.querySelectorAll('[data-testid="im-directory-group"]')];
  const section = sections.find((item) => item.textContent?.includes(title));
  if (!section) return -1;
  // 栏头之后、下一个栏头之前的行都属于这一栏
  let count = 0;
  let node = section.nextElementSibling;
  while (node && !node.matches('[data-testid="im-directory-group"]')) {
    if (node.querySelector('[data-testid="im-directory-row"]')) count += 1;
    node = node.nextElementSibling;
  }
  return count;
};

beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

afterEach(() => {
  cleanup();
  (globalThis.localStorage as Storage).clear();
});

describe("通讯录部门栏可折叠", () => {
  it("点栏头收起该栏的人、再点展开", () => {
    renderList();
    expect(rowsFor("测试与服务保障部")).toBe(2);

    fireEvent.click(screen.getAllByTestId("im-directory-group-toggle")[0] as HTMLElement);
    expect(rowsFor("测试与服务保障部")).toBe(0);
    // 别的栏不受影响
    expect(rowsFor("算力服务器事业部")).toBe(1);

    fireEvent.click(screen.getAllByTestId("im-directory-group-toggle")[0] as HTMLElement);
    expect(rowsFor("测试与服务保障部")).toBe(2);
  });

  it("折叠状态持久化：重新挂载后仍然收着", () => {
    const first = renderList();
    fireEvent.click(screen.getAllByTestId("im-directory-group-toggle")[0] as HTMLElement);
    expect(rowsFor("测试与服务保障部")).toBe(0);
    first.unmount();

    renderList();
    expect(rowsFor("测试与服务保障部")).toBe(0);
  });

  it("搜索时强制展开：搜到的人不能藏在折叠栏里", () => {
    renderList();
    fireEvent.click(screen.getAllByTestId("im-directory-group-toggle")[0] as HTMLElement);
    expect(rowsFor("测试与服务保障部")).toBe(0);

    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "蔡丽涛" } });
    expect(rowsFor("测试与服务保障部")).toBe(1);
    expect(
      [...document.querySelectorAll('[data-testid="im-directory-row"]')].some((row) =>
        row.textContent?.includes("蔡丽涛"),
      ),
    ).toBe(true);

    // 清掉搜索又回到折叠状态
    fireEvent.change(input, { target: { value: "" } });
    expect(rowsFor("测试与服务保障部")).toBe(0);
  });

  it("搜索按**任意**部门匹配（多部门的人不会漏）", () => {
    const multi = person("u-9", "王五", ["行政人事部", "研发管理部"]);
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ImDirectoryList, {
          users: [person("u-1", "蔡丽涛", ["测试与服务保障部"]), multi],
          onPick: vi.fn(),
        }),
      ),
    );
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "研发管理部" } });
    // 用行来断言：姓名两个字时头像缩写也是同两个字，`getByText` 会命中两个节点
    const picked = [...document.querySelectorAll('[data-testid="im-directory-row"]')];
    expect(picked.some((row) => row.textContent?.includes("王五"))).toBe(true);
  });
});
