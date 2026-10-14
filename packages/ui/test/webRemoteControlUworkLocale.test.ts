import { describe, expect, it } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

describe("UWork remote control locale coverage", () => {
  it("keeps Chinese coverage for all currently shipped English message IDs", () => {
    const translated = zhCN as Record<string, string>;
    // 中文的句式前缀允许为空（主句由 suffix 构成）；覆盖检查应区分空译文与完全缺失的 ID。
    expect(Object.keys(enUS).filter((key) => !Object.hasOwn(translated, key))).toEqual([]);
  });
  it("provides Chinese text for every existing remote control message", () => {
    const translated = zhCN as Record<string, string>;
    const remoteKeys = Object.keys(enUS).filter((key) => key.startsWith("webRemoteControl."));
    expect(remoteKeys.length).toBeGreaterThan(0);
    expect(remoteKeys.filter((key) => !translated[key])).toEqual([]);
  });

  it("keeps the mobile home branded as UWork", () => {
    expect((enUS as Record<string, string>)["webRemoteControl.mobileHome.title"]).toContain(
      "UWork",
    );
    expect((zhCN as Record<string, string>)["webRemoteControl.mobileHome.title"]).toContain(
      "UWork",
    );
  });
});
