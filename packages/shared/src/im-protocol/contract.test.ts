import { describe, expect, it } from "vitest";
import { parseImCard, parseImServerFrame } from "./contract.js";
import { exampleImCard } from "./contract.example.js";

describe("IM 协议契约", () => {
  it("卡片示例通过现有解析器，缺 fallback 的消息被拒绝", () => {
    expect(parseImCard(JSON.stringify(exampleImCard))).toMatchObject(exampleImCard);
    expect(
      parseImCard(JSON.stringify({ card: { version: 1, type: "example" }, title: "Report" })),
    ).toBeNull();
  });
  it("未知帧不会进入消息状态", () => {
    expect(parseImServerFrame(JSON.stringify({ type: "unknown" }))).toBeNull();
  });
});
