import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { test } from "vitest";
import { PlatformChannels } from "@zcode/shared";

async function nativeLoginIpcFixture() {
  const source = await readFile(
    new URL("../src/main/desktopMainIpcRemote.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile("desktopMainIpcRemote.ts", source, ts.ScriptTarget.Latest, true);
  const channels = new Set([
    "OpenEnterpriseLogin",
    "CancelEnterpriseLogin",
    "UpdateEnterpriseLogin",
  ]);
  const registrations: string[] = [];
  const bindings: { local: string; exported: string }[] = [];
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./enterpriseLoginView.js"
    ) {
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named))
        for (const name of named.elements)
          bindings.push({ local: name.name.text, exported: (name.propertyName ?? name.name).text });
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(ast) === "ipcMain"
    ) {
      const channel = node.arguments[0];
      if (channel && ts.isPropertyAccessExpression(channel) && channels.has(channel.name.text))
        registrations.push(`${node.getText(ast)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(registrations.length, 3);
  const calls: unknown[][] = [];
  const helpers: Record<string, unknown> = {
    openEnterpriseLoginView: async (...args: unknown[]) => {
      calls.push(["open", ...args]);
      return "fixture-callback";
    },
    cancelEnterpriseLoginView: (...args: unknown[]) => {
      calls.push(["cancel", ...args]);
    },
    updateEnterpriseLoginView: (...args: unknown[]) => {
      calls.push(["update", ...args]);
    },
  };
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const register = (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
    handlers.set(channel, handler);
  const js = ts.transpileModule(registrations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // 只注入生产源码真正导入的依赖；手工注入同名函数会掩盖缺失 import 的回归。
  new Function("ipcMain", "PlatformChannels", ...bindings.map((binding) => binding.local), js)(
    { handle: register, on: register },
    PlatformChannels,
    ...bindings.map((binding) => helpers[binding.exported]),
  );
  return { calls, handlers };
}

test("native login IPC invokes its actual imported view owner for open, cancel and surface updates", async () => {
  const { calls, handlers } = await nativeLoginIpcFixture();
  const frame = {};
  const event = { sender: { id: 42, mainFrame: frame }, senderFrame: frame };
  const request = { id: "fixture-attempt" };
  const update = { id: "fixture-attempt", surface: null };
  assert.equal(
    await handlers.get(PlatformChannels.OpenEnterpriseLogin)!(event, request),
    "fixture-callback",
  );
  handlers.get(PlatformChannels.CancelEnterpriseLogin)!(event, request.id);
  handlers.get(PlatformChannels.UpdateEnterpriseLogin)!(event, update);
  assert.deepEqual(calls, [
    ["open", event, request],
    ["cancel", 42, request.id],
    ["update", 42, update],
  ]);
});

test("native login IPC does not route another frame into the owning view", async () => {
  const { calls, handlers } = await nativeLoginIpcFixture();
  const event = { sender: { id: 42, mainFrame: {} }, senderFrame: {} };
  assert.throws(
    () => handlers.get(PlatformChannels.OpenEnterpriseLogin)!(event, {}),
    /owning window frame/,
  );
  handlers.get(PlatformChannels.CancelEnterpriseLogin)!(event, "fixture-attempt");
  handlers.get(PlatformChannels.UpdateEnterpriseLogin)!(event, {});
  assert.deepEqual(calls, []);
});
