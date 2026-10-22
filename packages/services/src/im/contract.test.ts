import { describe, expect, it, vi } from "vitest";
import { exampleImView } from "./contract.example.js";
import { createImHttpClient } from "./imHttpClient.js";
import { createImService } from "./imService.js";

describe("IM 服务宿主契约", () => {
  it("读取初始视图不联网，准入保持未知", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const createSocket = vi.fn(() => {
      throw new Error("Unexpected socket");
    });
    const client = createImHttpClient({
      resolveBaseUrl: async () => "https://im.example.test",
      resolveToken: async () => undefined,
      fetchImpl,
    });
    const service = createImService({
      client,
      createSocket,
      resolveUrl: async () => undefined,
      resolveToken: async () => undefined,
    });
    expect(await exampleImView(service)).toMatchObject({
      entitlement: null,
      connection: "idle",
      conversations: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });
});
