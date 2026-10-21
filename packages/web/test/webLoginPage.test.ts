// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebLoginPage } from "../src/auth/WebLoginPage.js";

describe("官方 V2 兼容登录页", () => {
  it.each(["zh-CN", "en-US"] as const)("%s 页头显示品牌与本地化登录标题", (lang) => {
    document.documentElement.lang = lang;
    const html = renderToStaticMarkup(createElement(WebLoginPage, { onLogin: () => {} }));
    expect(html).toContain("UWork");
    expect(html).toContain(
      lang === "zh-CN" ? "登录后继续使用 Web 远程控制" : "Sign In To Continue",
    );
  });
});
