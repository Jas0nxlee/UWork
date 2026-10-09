// 使用 browser-harness 检查真实浏览器中的共享组件；与真实企业微信授权验证分开。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = resolve(import.meta.dirname, "../../..");
const server = await createServer({
  configFile: false,
  root: resolve(import.meta.dirname, "enterprise-identity"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  server: { host: "127.0.0.1", port: 15490, strictPort: true, fs: { allow: [root] } },
});
await server.listen();
const code = String.raw`
import json, time, base64
from pathlib import Path
target=new_tab('http://127.0.0.1:15490')
activate_tab(target)
wait_for_load()
def read(expression):
    return js(expression)
def until(expression):
    for _ in range(100):
        if read(expression): return
        time.sleep(.1)
    print(page_info())
    print(read('document.body.innerText'))
    print(read('JSON.stringify(document.documentElement.dataset)'))
    print(read("(()=>{const e=document.querySelector('[data-testid=enterprise-login-skip]');if(!e)return {};const r=e.getBoundingClientRect(),s=getComputedStyle(e),c=e.closest('[data-slot=dialog-content]');return {rect:r.toJSON(),pointer:s.pointerEvents,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,700),animations:c?.getAnimations().map(a=>({state:a.playState,timing:a.effect.getComputedTiming()})),content:c?.getBoundingClientRect().toJSON()}})()"))
    Path('/tmp/uwork-identity-browser-failure.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    raise AssertionError(expression)
def click_test(testid):
    until("(()=>{const e=document.querySelector('[data-testid="+testid+"]'); if(!e)return false; const r=e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) && !e.closest('[data-slot=dialog-content]')?.getAnimations().some(a=>a.playState==='running')})()")
    backend=read("document.querySelector('[data-testid="+testid+"]').getBoundingClientRect().toJSON()")
    click_at_xy(backend['x']+backend['width']/2,backend['y']+backend['height']/2)
def enter_test_value(testid,value):
    doc=cdp('DOM.getDocument')
    field=cdp('DOM.querySelector',nodeId=doc['root']['nodeId'],selector='[data-testid='+testid+']')['nodeId']
    cdp('DOM.focus',nodeId=field)
    cdp('Input.insertText',text=value)
for oldfail in ['', '&old_fail=1']:
    target=new_tab('http://127.0.0.1:15490/?configured=1&multi_org=1'+oldfail)
    activate_tab(target)
    wait_for_load()
    until("!!document.querySelector('[data-org-id=bj][aria-checked=true]')")
    click_test('enterprise-wecom-login')
    until("document.documentElement.dataset.startOrganizations==='[\"bj\"]'")
    click_test('enterprise-login-organization-back')
    read("document.querySelector('[data-org-id=nj]').click()")
    until("!!document.querySelector('[data-org-id=nj][aria-checked=true]')")
    click_test('enterprise-wecom-login')
    assert read("document.documentElement.dataset.startOrganizations")=='["bj"]'
    read('window.releaseOldStart()')
    until("!!document.documentElement.dataset.nativeRequests")
    requests=json.loads(read('document.documentElement.dataset.nativeRequests'))
    assert len(requests)==1, requests
    assert requests[0]['expectedState']=='nj', requests
    assert 'appid=wx-nj' in requests[0]['authorizationUrl'], requests
    assert requests[0]['callbackUrl'].endswith('uwork_nonce=nj-2'), requests
    assert read('document.documentElement.dataset.startOrganizations')=='["bj","nj"]'
    cancelled=json.loads(read("document.documentElement.dataset.cancelledAttempts || '[]'"))
    assert 'nj-2' not in cancelled, cancelled
    click_test('enterprise-login-organization-back')
    until("!!document.querySelector('[data-org-id=nj][aria-checked=true]')")
    click_test('enterprise-wecom-login')
    until("JSON.parse(document.documentElement.dataset.nativeRequests).length===2")
    requests=json.loads(read('document.documentElement.dataset.nativeRequests'))
    assert requests[1]['id']=='nj-3'
    click_test('enterprise-login-skip')
print('PASS: delayed organization restart, old start failure and repeated return/retry')
`;
try {
  await new Promise((done, reject) => {
    const child = spawn("browser-harness", [], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(code);
    child.on("error", reject);
    child.on("exit", (status) =>
      status === 0 ? done() : reject(new Error(`Browser check failed: ${status}`)),
    );
  });
} finally {
  await server.close();
}
