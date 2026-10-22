// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createImHttpClient, ImHttpError } from "../../services/src/im/imHttpClient.js";

/**
 * IM 请求的错误信封解析。
 *
 * 真机 bug：工作项路由用的是 JSON:API 信封 `{errors:[{code,detail}]}`，而客户端只认 `{error,message}`，
 * 于是「你是作者，不能自审」被吞成了 `IM request failed: 400`——用户看不出为什么点不动。
 * 两种信封都得认，且**原因优先于状态码**。
 */
const client = (body: unknown, status: number) =>
  createImHttpClient({
    resolveBaseUrl: async () => "https://im.test",
    resolveToken: async () => "token",
    fetchImpl: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });

describe("IM 错误信封", () => {
  it("JSON:API 的 errors[].detail 要透出（工作项路由）", async () => {
    const http = client(
      { errors: [{ status: "400", code: "invalid", detail: "author cannot review own item" }] },
      400,
    );
    const failure = await http
      .reviewWorkItem({ itemId: "x", status: "reviewed" })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ImHttpError);
    expect((failure as ImHttpError).message).toBe("author cannot review own item");
    expect((failure as ImHttpError).code).toBe("invalid");
  });

  it("会话类的 {error,message} 仍然照旧", async () => {
    const http = client({ error: "im_not_allowed", message: "not in allowlist" }, 403);
    const failure = await http.conversations().catch((error) => error);
    expect((failure as ImHttpError).message).toBe("not in allowlist");
    expect((failure as ImHttpError).code).toBe("im_not_allowed");
  });

  it("只有 status、没有信封时，仍然给得出状态码（别倒退）", async () => {
    const http = client("boom", 502);
    const failure = await http.conversations().catch((error) => error);
    expect((failure as ImHttpError).message).toBe("IM request failed: 502");
  });
});
