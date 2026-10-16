import { startOfficeHarness } from "./scripts/lib/officeEditorHarness.mjs";
console.log("stage1: importing harness done", Date.now());
const h = await startOfficeHarness({
  prefix: "probe-",
  pages: { "index.html": "<!doctype html><div id=h></div><script>window.__ready=1</script>" },
  viewport: { width: 400, height: 300 },
});
console.log("stage2: harness up", Date.now(), await h.page.evaluate(() => window.__ready));
await h.close();
console.log("stage3: closed", Date.now());
