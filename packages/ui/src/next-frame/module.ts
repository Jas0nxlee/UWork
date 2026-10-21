export const nextFrameModule = {
  id: "next-frame",
  requires: [],
  provides: ["next-frame"],
  publicEntrypoints: ["packages/ui/src/lib/nextFrame.ts", "contract.ts"],
} as const;
