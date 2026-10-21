import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceCollection } from "@zcode/services";
import { SERVER_REMOTE_PROTOCOL_VERSION } from "@zcode/shared";
import { createHttpServer, type HttpServerOptions } from "../src/http.js";

describe("server info HTTP endpoint", () => {
  const servers: Array<ReturnType<typeof createHttpServer>> = [];
  const tempDirs: string[] = [];

  async function listen(options: HttpServerOptions = {}) {
    const server = createHttpServer(new ServiceCollection(), 0, options);
    servers.push(server);
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    return { server, address: server.address() as AddressInfo };
  }

  afterEach(async () => {
    await Promise.all(
      servers
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error?: Error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        ),
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("binds the default unauthenticated server to IPv4 loopback only", async () => {
    vi.stubEnv("ZCODE_SERVER_TOKEN", "");
    const { address } = await listen();

    // 修复依据：日志中的 localhost 不是监听边界，必须检查真实 socket 地址，避免匿名暴露工作区 RPC。
    expect(address.address).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ authRequired: false });
  });

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "remote.example.invalid",
    "127.0.0.1.evil.invalid",
    "localhost.",
  ])(
    "synchronously rejects non-loopback host %s without a token before attempting to bind",
    (host) => {
      vi.stubEnv("ZCODE_SERVER_TOKEN", "");
      // 不实际绑定用户局域网或解析外部主机；守卫必须在 Node listen 前同步拒绝。
      const bind = vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
        throw new Error("Unexpected network bind before credential validation");
      });

      expect(() => createHttpServer(new ServiceCollection(), 0, { host })).toThrow(/token/i);
      expect(bind).not.toHaveBeenCalled();
    },
  );

  it("treats a whitespace-only token as missing for a non-loopback bind", () => {
    vi.stubEnv("ZCODE_SERVER_TOKEN", "");
    const bind = vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
      throw new Error("Unexpected network bind before credential validation");
    });

    expect(() =>
      createHttpServer(new ServiceCollection(), 0, { host: "0.0.0.0", authToken: "   " }),
    ).toThrow(/token/i);
    expect(bind).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "::1", "localhost"])(
    "allows a token-free real loopback listener at %s",
    async (host) => {
      vi.stubEnv("ZCODE_SERVER_TOKEN", "");
      const { address } = await listen({ host });
      const actualHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
      const response = await fetch(`http://${actualHost}:${address.port}/api/server-info`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ authRequired: false });
    },
  );

  it.each(["127.1.2.3", "127.255.255.254"])(
    "recognizes the complete IPv4 loopback range for %s without credentials",
    (host) => {
      vi.stubEnv("ZCODE_SERVER_TOKEN", "");
      // 127/8 的准入规则不依赖本机是否给 lo0 配置了对应别名。
      const bind = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
        return this;
      });
      const server = createHttpServer(new ServiceCollection(), 0, { host });
      servers.push(server);
      expect(bind).toHaveBeenCalledOnce();
    },
  );

  it.each(["192.168.1.20", "remote.example.invalid"])(
    "admits explicitly authenticated host %s independently of local address availability",
    (host) => {
      const bind = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
        return this;
      });
      const server = createHttpServer(new ServiceCollection(), 0, {
        host,
        authToken: "binding-test-token",
      });
      servers.push(server);
      expect(bind).toHaveBeenCalledOnce();
    },
  );

  it.each(["0.0.0.0", "::"])(
    "allows authenticated non-loopback bind %s and protects APIs and capability issuance",
    async (host) => {
      vi.stubEnv("ZCODE_SERVER_TOKEN", "");
      const { address } = await listen({
        host,
        authToken: "binding-test-token",
        // 兼容标志不能覆盖实际 token 的鉴权事实。
        authRequired: false,
      });
      expect(address.address).toBe(host);
      const requestHost = address.family === "IPv6" ? "[::1]" : "127.0.0.1";
      const baseUrl = `http://${requestHost}:${address.port}`;
      for (const [path, method] of [
        ["/api/server-info", "GET"],
        ["/api/rpc-host-capability", "POST"],
      ]) {
        expect((await fetch(`${baseUrl}${path}`, { method })).status).toBe(401);
        expect((await fetch(`${baseUrl}${path}?token=wrong-token`, { method })).status).toBe(401);
        const accepted = await fetch(`${baseUrl}${path}?token=binding-test-token`, { method });
        expect(accepted.status).toBe(200);
        await expect(accepted.json()).resolves.toMatchObject(
          method === "GET" ? { authRequired: true } : { capability: expect.any(String) },
        );
      }
    },
  );

  it("reports actual authentication rather than a stale authRequired option or ambient token", async () => {
    vi.stubEnv("ZCODE_SERVER_TOKEN", "unapplied-ambient-token");
    const { address } = await listen({ host: "127.0.0.1", authRequired: true });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ authRequired: false });
  });

  it("returns desktop connector bootstrap metadata", async () => {
    const { address } = await listen({
      serverId: "studio",
      name: "Studio Server",
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      serverId: "studio",
      name: "Studio Server",
      version: expect.any(String),
      protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
      authRequired: false,
      compatibility: {
        schemaVersion: 1,
        productVersion: expect.any(String),
        minCompatibleVersion: expect.any(String),
      },
      migration: { failedPathCount: 0 },
      identity: { osUser: expect.any(String), hostname: expect.any(String) },
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: true,
      },
    });
  });

  it("announces virtual projects only for an initialized owner host", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      serverId: "owner",
      virtualProjects: true,
      migrationFailedPathCount: 2,
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);
    expect(await response.json()).toMatchObject({
      serverId: "owner",
      capabilities: { virtualProjects: true },
      migration: { failedPathCount: 2 },
    });
  });

  it("requires the lite token for protected API routes", async () => {
    const { address } = await listen({
      authToken: "secret-token",
    });
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const rejected = await fetch(`${baseUrl}/api/server-info`);
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`${baseUrl}/api/server-info?token=secret-token`);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toContain("zcode_lite_token=");

    const cookieAccepted = await fetch(`${baseUrl}/api/server-info`, {
      headers: {
        cookie: "zcode_lite_token=secret-token",
      },
    });
    expect(cookieAccepted.status).toBe(200);

    const capabilityRejected = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
    });
    expect(capabilityRejected.status).toBe(401);
    const capabilityAccepted = await fetch(
      `${baseUrl}/api/rpc-host-capability?token=secret-token`,
      { method: "POST" },
    );
    expect(capabilityAccepted.status).toBe(200);
    await expect(capabilityAccepted.json()).resolves.toMatchObject({
      capability: expect.any(String),
      expiresAt: expect.any(Number),
    });
  });

  it("does not expose either retired remote-connect route", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/connect-remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
    const websocketUpgradeRoute = await fetch(
      `http://127.0.0.1:${address.port}/ws/remote/retired-session`,
    );
    expect(websocketUpgradeRoute.status).toBe(404);
  });

  it("serves static web files with SPA fallback", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lite-static-"));
    tempDirs.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html>lite</html>", "utf8");
    await writeFile(join(staticRoot, "app.js"), "console.log('lite');", "utf8");

    const { address } = await listen({
      staticRoot,
      spaFallback: true,
    });
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const asset = await fetch(`${baseUrl}/app.js`);
    expect(asset.status).toBe(200);
    // 不同静态资源适配器使用两种合法 JS MIME；断言资源可执行类型而非库版本拼写。
    expect(asset.headers.get("content-type")).toMatch(/^(?:text|application)\/javascript(?:;|$)/);
    await expect(asset.text()).resolves.toBe("console.log('lite');");

    const fallback = await fetch(`${baseUrl}/workspace/deep/link`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("text/html");
    await expect(fallback.text()).resolves.toBe("<html>lite</html>");

    const apiFallback = await fetch(`${baseUrl}/api/missing`);
    expect(apiFallback.status).toBe(404);
  });
});
