import { readRelayConfigFromEnv } from "./config.js";
import { createRelayLogger } from "./logging.js";
import { createRelayServer } from "./server.js";

const logger = createRelayLogger();

async function main(): Promise<void> {
  const config = readRelayConfigFromEnv();
  const server = createRelayServer(config, { logger });
  const { host, port } = await server.listen();
  logger.info("relay listening", {
    host,
    port,
    wsPath: config.wsPath,
    version: config.version,
    stateFile: config.stateFile ?? "memory-only",
    allowedOrigins: config.allowedOrigins.length,
    adminEnabled: Boolean(config.adminToken),
  });
  if (config.allowedOrigins.length === 0) {
    logger.warn("RELAY_ALLOWED_ORIGINS 未配置：手机页 Origin 不做校验（仅适合本地调试）");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("relay shutting down", { signal });
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  logger.error("relay failed to start", { message: (error as Error).message });
  process.exit(1);
});
