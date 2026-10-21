import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (
  await Promise.all(
    ["page.js", "page_preview.js", "page_editor.js", "page_bootstrap.js"].map((name) =>
      readFile(new URL(`../ui/${name}`, import.meta.url), "utf8"),
    ),
  )
).join("\n");

async function pageHarness({ ready = true, exportBlob } = {}) {
  const nodes = new Map();
  const instances = [];
  const calls = [];
  const resources = [];
  function element() {
    return {
      hidden: false,
      disabled: false,
      textContent: "",
      classList: { toggle() {} },
      addEventListener() {},
      replaceChildren() {},
      append() {},
      querySelectorAll: () => [],
    };
  }
  const sandbox = vm.createContext({
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
      },
      body: element(),
      createElement: element,
    },
    window: { addEventListener() {} },
    setTimeout(callback) {
      callback();
    },
    clearTimeout() {},
    URLSearchParams,
    Blob,
    File,
    ArrayBuffer,
    Uint8Array,
    atob,
    btoa,
    SuperDoc: class {
      constructor(options) {
        this.document = options.document;
        this.destroyed = false;
        instances.push(this);
        if (ready) options.onReady();
      }
      destroy() {
        this.destroyed = true;
      }
      exportDocx() {
        return exportBlob ? exportBlob() : new Blob(["docx"]);
      }
    },
  });
  await vm.runInContext(
    `(async () => { ${source}\n globalThis.page = {
    state, applyTarget, mountEditor, saveEditor,
    setApp(value) { app = value; },
  }; })()`,
    sandbox,
  );
  const bridge = {
    getHostContext: () => ({ displayMode: "fullscreen" }),
    async callServerTool(call) {
      calls.push(call);
      if (call.name === "docx_write_back")
        return { structuredContent: { etag: "saved-version", counts: {} } };
      return { structuredContent: { items: [], total: 0, offset: 0, counts: {} } };
    },
    async readServerResource({ uri }) {
      resources.push(uri);
      if (uri === "office://superdoc/config")
        return { contents: [{ text: '{"baseUrl":"https://engine.example"}' }] };
      const url = new URL(uri);
      if (url.searchParams.has("meta"))
        return {
          contents: [
            {
              text: JSON.stringify({
                size: 4,
                chunkBytes: 4,
                chunks: 1,
                etag: `${url.searchParams.get("path")}-version`,
              }),
            },
          ],
        };
      return { contents: [{ blob: btoa("docx") }] };
    },
  };
  sandbox.page.setApp(bridge);
  const drain = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  return { page: sandbox.page, instances, calls, nodes, drain, resources };
}

test("switching targets destroys the previous document instance", async () => {
  const harness = await pageHarness();
  harness.page.state.path = "/A.docx";
  await harness.page.mountEditor();
  harness.page.applyTarget({ path: "/B.docx" });
  await harness.drain();
  assert.equal(harness.instances[0].destroyed, true);
  assert.equal(harness.instances.at(-1).document.name, "B.docx");
});

test("an export from the old target never writes into a newly selected file", async () => {
  let finishExport;
  const harness = await pageHarness({
    exportBlob: () =>
      new Promise((resolve) => {
        finishExport = resolve;
      }),
  });
  harness.page.state.path = "/A.docx";
  await harness.page.mountEditor();
  const saving = harness.page.saveEditor();
  harness.page.applyTarget({ path: "/B.docx" });
  finishExport(new Blob(["old A bytes"]));
  await saving;
  assert.equal(harness.calls.filter((call) => call.name === "docx_write_back").length, 0);
});

test("save sends the version read with this editor and records the new version", async () => {
  const harness = await pageHarness();
  harness.page.state.path = "/A.docx";
  await harness.page.mountEditor();
  const chunk = harness.resources
    .map((uri) => new URL(uri))
    .find((uri) => uri.searchParams.has("offset"));
  assert.equal(chunk.searchParams.get("etag"), "/A.docx-version");
  await harness.page.saveEditor();
  const saved = harness.calls.find((call) => call.name === "docx_write_back");
  assert.equal(saved.arguments.expectedEtag, "/A.docx-version");
  await harness.page.saveEditor();
  assert.equal(
    harness.calls.filter((call) => call.name === "docx_write_back").at(-1).arguments.expectedEtag,
    "saved-version",
  );
});

test("editor readiness timeout gives fallback and cannot claim it is ready", async () => {
  const harness = await pageHarness({ ready: false });
  harness.page.state.path = "/A.docx";
  await harness.page.mountEditor();
  assert.equal(harness.page.state.editorUnavailable, true);
  assert.doesNotMatch(harness.nodes.get("editor-status").textContent, /编辑器就绪/);
});

test("oversized saves fail before sending a frame to the MCP bridge", async () => {
  const harness = await pageHarness({
    exportBlob: () => new Blob([new Uint8Array(6 * 1024 * 1024 + 1)]),
  });
  harness.page.state.path = "/A.docx";
  await harness.page.mountEditor();
  await harness.page.saveEditor();
  assert.equal(harness.calls.filter((call) => call.name === "docx_write_back").length, 0);
  assert.match(harness.nodes.get("editor-status").textContent, /上限/);
});
