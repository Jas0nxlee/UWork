import { describe, expect, it } from "vitest";
import * as shared from "@zcode/shared";

describe("UWork 自建 HMAC QR 与官方 V2 信任隔离", () => {
  it("保留完整 HMAC 配对材料，同时官方 parser 继续拒绝此链接", () => {
    const url = new URL(
      shared.buildWebRemoteControlHmacQrUrl({
        baseUrl: "https://relay.example/remote/v4",
        deviceSid: "device-hmac",
        passHash: "test-hash",
        timestamp: 123,
        deviceMid: "desktop-mid",
        deviceName: "UWork",
        appVersion: "3.16.6",
      }),
    );
    expect(shared.parseWebRemoteControlHmacQrParams(url.searchParams)).toEqual({
      deviceSid: "device-hmac",
      passHash: "test-hash",
      timestamp: 123,
      deviceMid: "desktop-mid",
      deviceName: "UWork",
      appVersion: "3.16.6",
    });
    expect(shared.parseWebRemoteControlExternalQrParams(url.searchParams)).toBeNull();
  });

  it.each([
    "sid=x",
    "sid=x&hash=y",
    "sid=x&hash=y&t=NaN",
    "sid=x&hash=y&t=-1",
    "sid=x&sid=y&hash=z&t=1",
  ])("HMAC admission 拒绝不完整或歧义配对材料：%s", (query) => {
    expect(shared.parseWebRemoteControlHmacQrParams(new URLSearchParams(query))).toBeNull();
  });
});
