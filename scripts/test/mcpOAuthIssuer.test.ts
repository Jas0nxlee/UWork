import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSharedZCodeCredentialStore } from "../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.js";
import {
  loadCredentialPair,
  publishCanonicalCredentials,
} from "../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.js";
import { refreshMcpOAuthTokensUnderLock } from "../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.js";
import { saveDiscoveryRecord } from "../../apps/zcode-cli/packages/adapters/src/mcp/oauth-shared.js";

for (const scenario of [
  "same",
  "slash",
  "changed",
  "path-changed",
  "legacy",
  "offline",
  "offline-reactive",
] as const) {
  test(`MCP refresh binds saved credentials to their issuer: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-mcp-issuer-"));
    const store = createSharedZCodeCredentialStore({
      filePath: join(root, "credentials.json"),
      env: {},
    });
    const issuer = "https://issuer.example";
    const discovered =
      scenario === "changed"
        ? "https://other.example"
        : scenario === "path-changed"
          ? issuer + "/other"
          : issuer;
    const offline = scenario === "offline" || scenario === "offline-reactive";
    let tokenRequests = 0;
    try {
      await publishCanonicalCredentials(store, "fixture", {
        clientInformation: { client_id: "fixture-client", client_secret: "fixture-secret" },
        ...(scenario === "legacy" ? {} : { issuer: scenario === "slash" ? issuer + "/" : issuer }),
        publishedBy: "fixture",
        tokens: {
          access_token: "fixture-old",
          refresh_token: "fixture-refresh",
          token_type: "Bearer",
        },
      });
      const before = await loadCredentialPair(store, "fixture");
      await saveDiscoveryRecord(
        store,
        "fixture",
        {
          authorizationServerUrl: discovered,
          authorizationServerMetadata: {
            issuer: discovered,
            authorization_endpoint: discovered + "/authorize",
            token_endpoint: discovered + "/token",
            response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
          },
        },
        offline ? 0 : Date.now(),
      );
      const request = refreshMcpOAuthTokensUnderLock({
        credentialStore: store,
        keyPrefix: "fixture",
        reactive: scenario === "offline-reactive",
        serverName: "fixture",
        serverUrl: "https://mcp.example/mcp",
        fetchFn: async (url, init) => {
          if (offline) throw new Error("fixture offline");
          const target = String(url);
          if (init?.method === "POST") {
            tokenRequests += 1;
            assert.equal(target, discovered + "/token");
            return new Response(
              JSON.stringify({
                access_token: "fixture-new",
                token_type: "Bearer",
                refresh_token: "fixture-next",
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          if (target.includes("oauth-protected-resource")) {
            return new Response(
              JSON.stringify({
                resource: "https://mcp.example/mcp",
                authorization_servers: [discovered],
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              issuer: discovered,
              authorization_endpoint: discovered + "/authorize",
              token_endpoint: discovered + "/token",
              response_types_supported: ["code"],
              token_endpoint_auth_methods_supported: ["client_secret_post"],
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      });
      if (scenario === "same" || scenario === "slash") {
        assert.equal(await request, "fixture-new");
        assert.equal(tokenRequests, 1);
        assert.equal((await loadCredentialPair(store, "fixture"))?.issuer, before?.issuer);
      } else if (scenario === "offline") {
        assert.equal(await request, "fixture-old");
        assert.equal(tokenRequests, 0);
        assert.equal((await loadCredentialPair(store, "fixture"))?.raw, before?.raw);
      } else if (scenario === "offline-reactive") {
        await assert.rejects(request, { code: "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE" });
        assert.equal(tokenRequests, 0);
        assert.equal((await loadCredentialPair(store, "fixture"))?.raw, before?.raw);
      } else {
        await assert.rejects(request, {
          code: "MCP_OAUTH_INTERACTIVE_REQUIRED",
          reason: "unauthorized",
        });
        assert.equal(tokenRequests, 0, "credentials must never be POSTed to an unbound issuer");
        assert.equal((await loadCredentialPair(store, "fixture"))?.raw, before?.raw);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
