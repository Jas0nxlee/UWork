import type { ProviderConfigObject } from "@zcode/provider";
import type { ApiClient } from "@zcode/shared";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 5000;
const MAX_PAGES = 20;

function modelUrls(baseUrl: string): URL[] {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("请填写有效的模型服务 Base URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Base URL 仅支持 HTTP/HTTPS，不能包含账号、查询参数或片段");
  }
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|responses|messages)$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path || "/v1"}/models`;
  if (path) return [url];
  const fallback = new URL(url);
  fallback.pathname = "/models";
  return [url, fallback];
}

async function readBoundedJson(
  response: Response,
  budget: { remaining: number },
): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > budget.remaining) {
    await response.body?.cancel();
    throw new Error("模型列表超过大小限制，未添加任何模型");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型列表响应为空");
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) throw new Error("模型列表超过大小限制，未添加任何模型");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("模型列表不是有效 JSON，请检查 Base URL");
  }
}

/** 只枚举当前供应商公开的模型 ID；不进行推理请求，也不相信远端给出的跳转 URL。 */
export async function discoverProviderModels(
  config: ProviderConfigObject,
  client: Pick<ApiClient, "request">,
): Promise<readonly string[]> {
  const api = config.api;
  if (!api?.baseUrl?.trim()) throw new Error("请先填写 Base URL");
  if (
    !api.type ||
    !["openai-chat-completions", "openai-responses", "anthropic-messages"].includes(api.type)
  )
    throw new Error("当前 API 格式不支持自动获取模型");
  if (config.access?.type !== "api-key") throw new Error("仅自定义 API Key 供应商支持自动获取模型");
  const urls = modelUrls(api.baseUrl.trim());
  let headers: Headers;
  try {
    headers = new Headers(api.headers ?? {});
    headers.set("accept", "application/json");
    const key = config.access.apiKey?.trim();
    if (api.type === "anthropic-messages") {
      if (key && !headers.has("x-api-key")) headers.set("x-api-key", key);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    } else if (key && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
  } catch {
    throw new Error("供应商请求头配置无效");
  }
  const signal = AbortSignal.timeout(15_000);
  const budget = { remaining: MAX_BYTES };
  const ids = new Set<string>(),
    cursors = new Set<string>();
  let url = urls[0]!;
  for (let page = 0; page < MAX_PAGES; page++) {
    let response: Response;
    try {
      response = await client.request(url, { method: "GET", headers, signal, redirect: "error" });
      if (page === 0 && urls[1] && [404, 405].includes(response.status)) {
        await response.body?.cancel();
        url = urls[1];
        response = await client.request(url, { method: "GET", headers, signal, redirect: "error" });
      }
    } catch {
      throw new Error(
        signal.aborted
          ? "获取模型超时，请稍后重试"
          : "无法连接模型列表接口，请检查地址、代理及证书配置",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`获取模型失败（HTTP ${response.status}），请检查 Base URL 和 API Key`);
    }
    let body: unknown;
    try {
      body = await readBoundedJson(response, budget);
    } catch (error) {
      if (signal.aborted) throw new Error("获取模型超时，请稍后重试");
      // 不把网络异常、服务端原文或请求头带回 UI，避免上游错误回显密钥。
      if (error instanceof Error && /^(模型列表)/.test(error.message)) throw error;
      throw new Error("模型列表读取失败，请重试");
    }
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const data = Array.isArray(body) ? body : envelope?.data;
    if (!Array.isArray(data)) throw new Error("模型列表格式不受支持，请检查 Base URL");
    for (const item of data) {
      const raw =
        typeof item === "string" ? item : item && typeof item === "object" ? item.id : null;
      if (typeof raw !== "string") throw new Error("模型列表包含无效的模型 ID");
      const id = raw.trim();
      if (!id) continue;
      if (
        id.length > 512 ||
        Array.from(id).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        throw new Error("模型列表包含无效的模型 ID");
      ids.add(id);
      if (ids.size > MAX_MODELS) throw new Error("模型列表超过数量限制，未添加任何模型");
    }
    if (envelope?.has_more !== true) return [...ids];
    const cursor = envelope.last_id;
    if (typeof cursor !== "string" || !cursor.trim() || cursor.length > 512 || cursors.has(cursor))
      throw new Error("模型列表分页无效，未添加任何模型");
    cursors.add(cursor);
    url = new URL(url);
    url.searchParams.set("after_id", cursor);
  }
  throw new Error("模型列表超过分页限制，未添加任何模型");
}
