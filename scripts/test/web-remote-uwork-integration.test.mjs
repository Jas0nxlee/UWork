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
  ]) {
    assert.match(between(source, start, end), /enterpriseIdentityReadOnly\b/, start);
  }
  const bootstrap = between(source, "async function resolveWebBootstrap()", "async function");
  assert.match(
    bootstrap,
    /if \(remoteId\)\s*\{\s*return \{ wsUrl, enterpriseIdentityReadOnly: true \}/,
  );
  assert.match(source, /enterpriseIdentityReadOnly=\{bootstrap\.enterpriseIdentityReadOnly\}/);
});

test("Root preserves the phone bridge projection and selects replayable workbench semantics", async () => {
  const source = await readSource("packages/ui/src/Root.tsx");
  const rootInner = between(source, "function RootInner({", "}: RootProps)");
  const workspaceContent = source.slice(source.indexOf("<RootWorkspaceContent"));
  for (const field of [
    "webRemoteControlWorkspaceSwitcher",
    "initialWebRemoteControlMobileNavigationIntent",
    "webRemoteControlTerminalTransportState",
  ]) {
    assert.match(rootInner, new RegExp(`\\b${field}\\b`));
    assert.match(workspaceContent, new RegExp(`${field}=\\{\\s*${field}\\s*\\}`));
  }
  // 项目树重构后，Host 目录整组替代旧 initial workspace/task 快照；禁止恢复第二份行集合。
  assert.match(source, /<ProjectDirectoryProvider\b/);
  const tree = await readSource("packages/ui/src/project-sidebar/useProjectTree.ts");
  assert.match(tree, /services\.windowProjectDirectory \?\? services/);
  assert.match(tree, /readProjectSidebarTree\(\{/);
  assert.match(tree, /projectService: service/);
  assert.match(
    source,
    /workbenchGroupClientMode:\s*isWebRemoteControlRoot\s*\?\s*"web-remote-replayable"\s*:\s*"desktop-continuous"/,
  );
});

test("wide and mobile project Sidebar share the Host tree and complete switching lifecycle", async () => {
  const entry = await readSource("packages/ui/src/WorkspaceSidebar.tsx");
  assert.match(entry, /ProjectSidebar as WorkspaceSidebar/);
  const sidebar = await readSource("packages/ui/src/project-sidebar/index.tsx");
  assert.match(sidebar, /useProjectTaskNavigation\(props, tree, remoteService\)/);
  const navigation = await readSource(
    "packages/ui/src/project-sidebar/useProjectTaskNavigation.ts",
  );
  assert.match(navigation, /switcher: props\.webRemoteControlWorkspaceSwitcher/);
  assert.match(navigation, /onTaskOpen: props\.onWebRemoteTaskOpen/);
  assert.match(navigation, /onSwitchingChange: props\.onWebRemoteTaskSwitchingChange/);
  assert.match(navigation, /workspaceIdentity: identity/);
  assert.match(navigation, /mobileNavigationIntent: "chat"/);
  const shell = await readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
  assert.match(shell, /renderTaskHome=\{renderWorkspaceSidebar\}/);
  assert.match(shell, /switcher=\{webRemoteControlWorkspaceSwitcher\}/);
  const homeOnly = await readSource("packages/ui/src/project-sidebar/useHomeOnlyWorkspaces.ts");
  assert.match(homeOnly, /switcher\.listWorkspaces\(\)/);
  assert.match(homeOnly, /switcher\.onWorkspaceListUpdated/);
  assert.match(homeOnly, /request === generation\.current/);
});
