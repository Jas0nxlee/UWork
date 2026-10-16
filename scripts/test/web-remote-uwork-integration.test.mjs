import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../../", import.meta.url);
const readSource = (path) => readFile(new URL(path, rootUrl), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} must remain inspectable`);
  return source.slice(start, end);
}

test("every phone attachment entry explicitly uses the existing Host identity read-only", async () => {
  const source = await readSource("packages/web/src/main.tsx");
  for (const [start, end] of [
    ["const renderExternalRelayRoot =", "const renderExternalRelayHomeOnlyRoot ="],
    ["const renderExternalRelayHomeOnlyRoot =", "bootstrapPairedSession ="],
    ["const renderBridgeRoot =", "const openWorkspaceBridge ="],
  ]) {
    assert.match(between(source, start, end), /enterpriseIdentityReadOnly\b/, start);
  }
});

test("Root preserves the phone bridge projection and selects replayable workbench semantics", async () => {
  const source = await readSource("packages/ui/src/Root.tsx");
  const rootInner = between(source, "function RootInner({", "}: RootProps)");
  const workspaceContent = source.slice(source.indexOf("<RootWorkspaceContent"));
  for (const field of [
    "webRemoteControlWorkspaceSwitcher",
    "initialWebRemoteControlMobileNavigationIntent",
    "initialWebRemoteControlWorkspaceList",
    "webRemoteControlTerminalTransportState",
  ]) {
    assert.match(rootInner, new RegExp(`\\b${field}\\b`));
    assert.match(workspaceContent, new RegExp(`${field}=\\{\\s*${field}\\s*\\}`));
  }
  assert.match(
    source,
    /workbenchGroupClientMode:\s*isWebRemoteControlRoot\s*\?\s*"web-remote-replayable"\s*:\s*"desktop-continuous"/,
  );
});

test("wide remote Sidebar consumes the same task index and switching lifecycle callbacks", async () => {
  const source = await readSource("packages/ui/src/WorkspaceSidebar.tsx");
  assert.match(source, /<WebRemoteControlTaskIndex\b/);
  assert.match(source, /switcher=\{webRemoteControlWorkspaceSwitcher\}/);
  assert.match(source, /onTaskOpen=\{onWebRemoteTaskOpen\}/);
  assert.match(source, /onCrossWorkspaceSwitchingChange=\{onWebRemoteTaskSwitchingChange\}/);
  assert.doesNotMatch(
    source,
    /:\s*_(?:webRemoteControlWorkspaceSwitcher|isWebRemoteControl|onWebRemoteTaskOpen|onWebRemoteTaskSwitchingChange)\b/,
  );
});
