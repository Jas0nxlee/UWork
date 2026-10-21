import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IGenUiService } from "./index.js";
import { createGenUiService } from "./node.js";
import { exampleGenUiPrepare } from "./contract.example.js";

describe("gen-ui-service public contract", () => {
  it("binds the exported descriptor to the gen-ui channel", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("persists widget state through the public interface and isolates identity and session", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "gen-ui-contract-"));
    const first = createGenUiService({ stateRoot });
    const second = createGenUiService({ stateRoot });
    const writer: IGenUiService = first;
    const reader: IGenUiService = second;
    const scope = {
      workspacePath: exampleGenUiPrepare.workspacePath,
      sessionId: exampleGenUiPrepare.sessionId,
      workspaceIdentity: "remote:contract-workspace",
    };
    const target = { ...scope, path: exampleGenUiPrepare.path };
    const state = { modelContent: { selected: "annual" }, privateContent: { expanded: true } };
    try {
      await writer.setState({ target, state });
      first.dispose();
      expect(await reader.getState(target)).toEqual(state);
      expect(await reader.listState(scope)).toEqual([{ path: target.path, state }]);
      expect(await reader.getState({ ...target, workspacePath: "/relocated" })).toEqual(state);
      expect(
        await reader.getState({ ...target, workspaceIdentity: "remote:other-workspace" }),
      ).toBeNull();
      expect(await reader.getState({ ...target, sessionId: "other-session" })).toBeNull();
    } finally {
      first.dispose();
      second.dispose();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
