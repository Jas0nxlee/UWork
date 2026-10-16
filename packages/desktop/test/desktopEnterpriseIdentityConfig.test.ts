import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { resolveBundledEnterpriseIdentityConfigFilePath } from "../src/main/desktopEnterpriseIdentityConfig.js";
import { hostInitLocalMessageSchema } from "@zcode/shared";

test("Main gives Host a packaged resource path and validates bootstrap propagation", () => {
  const path = resolveBundledEnterpriseIdentityConfigFilePath({
    isPackaged: true,
    resourcesPath: "/fixture/resources",
    appPath: "/fixture/app.asar",
  });
  assert.equal(path, join("/fixture/resources", "config", "enterprise-identity.json"));
  const parsed = hostInitLocalMessageSchema.parse({
    type: "init-local",
    zcodeBuiltinProviderConfigFilePath: "/fixture/provider.json",
    enterpriseIdentityBuiltinConfigFilePath: path,
  });
  assert.equal(parsed.enterpriseIdentityBuiltinConfigFilePath, path);
  assert.equal(
    resolveBundledEnterpriseIdentityConfigFilePath({
      isPackaged: false,
      resourcesPath: "/fixture/resources",
      appPath: "/fixture/desktop",
    }),
    join("/fixture/desktop", ".release-config", "enterprise-identity.json"),
  );
});

test("the actual Main window callback injects bundled config into every Local Host", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === "spawnHostProcess" &&
      ts.isArrowFunction(node.initializer)
    )
      callback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback, "Main must retain the window-scoped Host bootstrap callback");
  // 执行生产回调的真实消息装配，避免测试手工注入字段却漏掉 Main 接线回归。
  assert.ok(ts.isCallExpression(callback.body));
  // 只隔离与消息无关的遥测/调度选项；保留真实 spawn 的 win、label 和 InitLocal 表达式。
  const isolated = ts.factory.updateArrowFunction(
    callback,
    callback.modifiers,
    callback.typeParameters,
    callback.parameters,
    callback.type,
    callback.equalsGreaterThanToken,
    ts.factory.updateCallExpression(
      callback.body,
      callback.body.expression,
      callback.body.typeArguments,
      callback.body.arguments.slice(0, 3),
    ),
  );
  const expression = ts.createPrinter().printNode(ts.EmitHint.Expression, isolated, ast);
  const js = ts.transpileModule(`const callback = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  for (const isPackaged of [true, false]) {
    let message: unknown;
    const invoke = new Function(
      "spawnHostProcess",
      "resolveZCodeBuiltinProviderConfigFilePath",
      "resolveBundledEnterpriseIdentityConfigFilePath",
      "app",
      "process",
      `${js} return callback;`,
    )(
      (_win: unknown, _label: unknown, init: unknown) => {
        message = init;
      },
      () => "/fixture/provider.json",
      resolveBundledEnterpriseIdentityConfigFilePath,
      { isPackaged, getAppPath: () => "/fixture/desktop" },
      { resourcesPath: "/fixture/resources" },
    );
    invoke({}, "fixture-window", { type: "init-local", hostId: "fixture-host" });
    const parsed = hostInitLocalMessageSchema.parse(message);
    assert.equal(
      parsed.enterpriseIdentityBuiltinConfigFilePath,
      resolveBundledEnterpriseIdentityConfigFilePath({
        isPackaged,
        resourcesPath: "/fixture/resources",
        appPath: "/fixture/desktop",
      }),
    );
    assert.equal(parsed.hostId, "fixture-host");
  }
});
