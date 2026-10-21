export const relayModule = {
  id: "relay",
  requires: ["shared"],
  provides: ["web-remote-control-relay"],
  publicEntrypoints: ["src/index.ts"],
} as const;
