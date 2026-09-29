import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCliPrefixSection } from "../../apps/zcode-cli/packages/core/src/context/sections/cli-prefix.js";
import {
  buildIdentitySection,
  buildSecurityNotice,
} from "../../apps/zcode-cli/packages/core/src/context/sections/identity.js";
import { buildDesktopContextSection } from "../../apps/zcode-cli/packages/core/src/context/sections/desktop.js";
import { buildGeneralPurposeSystemPrompt } from "../../apps/zcode-cli/packages/core/src/subagent/general-purpose.js";
import { buildExploreAgentPrompt } from "../../apps/zcode-cli/packages/core/src/subagent/explore.js";
import { resolveZCodeBuiltinPromptCommand } from "../../apps/zcode-cli/packages/bootstrap/src/builtin-prompt-command.js";
import { buildZCodeSourceHeadersFromContext } from "../../packages/shared/src/zcode-source-headers.js";
import { withOpenRouterAttributionHeaders } from "../../packages/shared/src/openrouter-attribution.js";
import {
  getDesktopMenuMessage,
  desktopMenuMessageIds,
} from "../../packages/shared/src/desktopMenu.js";

test("default and styled model contexts identify UWork and retain security guidance", () => {
  const sections = [buildCliPrefixSection(), buildIdentitySection(), buildDesktopContextSection()];
  for (const section of sections) {
    assert.match(section.content, /UWork/);
    assert.doesNotMatch(section.content, /\bZCode\b/);
    assert.equal(section.chars, section.content.length);
  }
  assert.ok(sections[1]!.content.includes(buildSecurityNotice()));
  const styled = buildIdentitySection({ name: "fixture", prompt: "fixture" });
  assert.match(styled.content, /UWork's tools/);
  assert.ok(styled.content.includes(buildSecurityNotice()));
});

test("subagent prompts use UWork without weakening their task constraints", () => {
  assert.match(buildGeneralPurposeSystemPrompt(), /UWork CLI/);
  const explore = buildExploreAgentPrompt({ embeddedSearchEnabled: true });
  assert.match(explore, /UWork Explore/);
  assert.match(explore, /READ-ONLY MODE/);
  assert.doesNotMatch(explore, /\bZCode\b/);
});

test("init branding preserves actual instruction paths and user instructions", () => {
  const prompt = resolveZCodeBuiltinPromptCommand("/init keep fixture instruction", {
    workingDirectory: "/tmp/workspace-fixture",
  })!;
  assert.match(prompt, /UWork's built-in \/init/);
  assert.match(prompt, /future UWork agents/);
  assert.ok(prompt.includes(".zcode/AGENTS.md"));
  assert.ok(prompt.includes("keep fixture instruction"));
  assert.equal(resolveZCodeBuiltinPromptCommand("/not-init"), undefined);
});

test("source attribution changes display values while keeping protocol header keys", () => {
  const headers = buildZCodeSourceHeadersFromContext({
    appVersion: "3.14.4",
    sourceTitle: "desktop",
    endpointOrigin: "https://service.example",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(headers["User-Agent"], "UWork/3.14.4");
  assert.equal(headers["X-Title"], "UWork@desktop");
  assert.equal(headers["X-ZCode-App-Version"], "3.14.4");
  assert.equal(headers["HTTP-Referer"], "https://service.example");
  assert.equal(
    withOpenRouterAttributionHeaders(headers, "https://openrouter.ai/api/v1")["X-OpenRouter-Title"],
    "UWork",
  );
});

test("native menu branding and historical data paths remain consistent", async () => {
  assert.equal(getDesktopMenuMessage("zh-CN", desktopMenuMessageIds.helpAbout), "关于 UWork");
  const runtime = await readFile(resolve("packages/desktop/src/main/desktopRuntimeEnv.ts"), "utf8");
  assert.ok(runtime.includes('"UWork Dev"'));
  assert.ok(runtime.includes('? "ZCode Dev"'));
  const helper = await readFile(resolve("packages/zcode-cua/broker-helper-constants.js"), "utf8");
  assert.match(helper, /HELPER_DISPLAY_NAME = "UWork Computer Use"/);
  assert.match(helper, /HELPER_APP_NAME = "ZCode Computer Use.app"/);
});
