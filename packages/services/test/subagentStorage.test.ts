import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/paths.js", () => ({
  getUworkUserStorageRoot: () => runtime.root,
  getUworkUserCliConfigPath: () => join(runtime.root, "cli", "config.json"),
}));
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
} from "../src/subagents/subagentStorage.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subagent-storage-isolation-"));
  runtime.root = join(root, "runtime");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Subagent storage isolation", () => {
  it("uses explicit home for agents and state even when the runtime has another root", async () => {
    const homeDir = join(root, "isolated");
    expect(await resolveUserSubagentRoot({ homeDir })).toBe(join(homeDir, ".uwork", "agents"));
    expect(await resolveSubagentStateFile({ homeDir })).toBe(
      join(homeDir, ".uwork", "v2", "agents-state.json"),
    );
    expect(await resolveUserSubagentRoot()).toBe(join(runtime.root, "agents"));
    expect(await resolveUserSubagentRoot({ homeDir: " " })).toBe(join(runtime.root, "agents"));
  });

  it("reads storage.dir only from the selected instance and expands its home", async () => {
    const homeDir = join(root, "isolated");
    for (const [configRoot, dir] of [
      [join(homeDir, ".uwork"), "~/custom-storage"],
      [runtime.root, "~/runtime-storage"],
      [join(homeDir, ".zcode"), "~/legacy-storage"],
    ] as const) {
      await mkdir(join(configRoot, "cli"), { recursive: true });
      await writeFile(join(configRoot, "cli", "config.json"), JSON.stringify({ storage: { dir } }));
    }
    expect(await resolveUserSubagentRoot({ homeDir })).toBe(
      join(homeDir, "custom-storage", "agents"),
    );
    expect(await resolveSubagentStateFile({ homeDir })).toBe(
      join(homeDir, "custom-storage", "v2", "agents-state.json"),
    );
  });

  it("keeps built-in overrides and custom profiles in their owning service instance", async () => {
    const homeDir = join(root, "first");
    const first = createSubagentsService({ homeDir });
    const second = createSubagentsService({ homeDir: join(root, "second") });
    try {
      await first.setBuiltInModelOverride({
        agentName: "general-purpose",
        modelSelection: {
          providerId: "fixture-provider",
          modelId: "fixture-model",
          options: { reasoningLevel: "high" },
        },
      });
      const { agent } = await first.createAgent({
        config: { name: "fixture", description: "Fixture", systemPrompt: "Fixture" },
      });
      expect(agent.path).toBe(join(homeDir, ".uwork", "agents", "fixture.md"));
      const other = await second.list({
        workspacePath: join(root, "workspace"),
        mode: "settingsUserOnly",
      });
      expect(
        other.agents.find((entry) => entry.name === "general-purpose")?.modelSelection,
      ).toBeUndefined();
      expect(other.agents.some((entry) => entry.name === "fixture")).toBe(false);
      await expect(readFile(join(runtime.root, "v2", "agents-state.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      first.disposeAll();
      second.disposeAll();
    }
  });
});
