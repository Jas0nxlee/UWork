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
import json, time
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
    print(read("(()=>{const e=document.querySelector('[data-testid=enterprise-login-skip]');if(!e)return {};const r=e.getBoundingClientRect(),s=getComputedStyle(e),c=e.closest('[data-slot=dialog-content]');return {rect:r.toJSON(),pointer:s.pointerEvents,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,700),animations:c?.getAnimations().map(a=>({state:a.playState,timing:a.effect.getComputedTiming()})),content:c?.getBoundingClientRect().toJSON()}})()"))
    import base64
    from pathlib import Path
    Path('/tmp/uwork-identity-browser-failure.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    raise AssertionError(expression)
def click_test(testid):
    until("(()=>{const e=document.querySelector('[data-testid="+testid+"]'); if(!e)return false; const r=e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) && !e.closest('[data-slot=dialog-content]')?.getAnimations().some(a=>a.playState==='running')})()")
    backend=read("document.querySelector('[data-testid="+testid+"]').getBoundingClientRect().toJSON()")
    click_at_xy(backend['x']+backend['width']/2,backend['y']+backend['height']/2)
until("!!document.querySelector('[data-testid=enterprise-login-page]')")
assert read("document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
assert '暂未配置' in read('document.body.innerText')
assert not read("!!document.querySelector('[data-testid=enterprise-login-card] [aria-label=UWork]')")
assert '使用企业身份登录，也可以跳过并继续使用本地功能' not in read('document.body.innerText')
assert '跳过登录不影响本地工作区和模型配置' not in read('document.body.innerText')
click_test('enterprise-login-skip')
until("!document.querySelector('[data-testid=enterprise-login-page]')")
target=new_tab('http://127.0.0.1:15490/?configured=1&slowrestore=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-login-page]')")
assert '暂未配置' not in read('document.body.innerText')
assert '正在检查企业微信登录状态' in read('document.body.innerText')
click_test('enterprise-login-skip')
until("!!document.querySelector('[data-testid=enterprise-identity-name]')")
assert not read('document.documentElement.dataset.cancelWithoutId')
target=new_tab('http://127.0.0.1:15490')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-identity-entry]')")
cdp('DOM.enable')
doc=cdp('DOM.getDocument')
draft=cdp('DOM.querySelector',nodeId=doc['root']['nodeId'],selector='[data-testid=local-draft]')['nodeId']
cdp('DOM.focus',nodeId=draft)
cdp('Input.insertText',text='未提交的本地草稿')
click_test('enterprise-identity-entry')
until("!!document.querySelector('[data-testid=enterprise-login-page]')")
cdp('Input.dispatchKeyEvent',type='keyDown',key='Escape',code='Escape',windowsVirtualKeyCode=27)
cdp('Input.dispatchKeyEvent',type='keyUp',key='Escape',code='Escape',windowsVirtualKeyCode=27)
until("!document.querySelector('[data-testid=enterprise-login-page]')")
assert read("document.querySelector('[data-testid=local-draft]').value")=='未提交的本地草稿'
for width in [320,768,1024,1440]:
    cdp('Emulation.setDeviceMetricsOverride',width=width,height=850,deviceScaleFactor=1,mobile=False)
    click_test('enterprise-identity-entry')
    until("!!document.querySelector('[data-testid=enterprise-login-page]')")
    assert read('document.documentElement.scrollWidth <= innerWidth'), width
    if width==1440:
        import base64
        from pathlib import Path
        Path('/tmp/uwork-enterprise-login-browser.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    click_test('enterprise-login-skip')
    until("!document.querySelector('[data-testid=enterprise-login-page]')")
target=new_tab('http://127.0.0.1:15490/?configured=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-wecom-login]') && !document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
click_test('enterprise-wecom-login')
until("!!document.querySelector('[data-testid=enterprise-identity-name]')")
assert '测试用户' in read("document.querySelector('[data-testid=enterprise-identity-name]').textContent")
boxes=read("JSON.stringify(['[aria-label=UWork]','[data-testid=enterprise-identity-name]'].map(s=>document.querySelector(s).getBoundingClientRect().toJSON()))")
boxes=json.loads(boxes)
assert boxes[1]['y'] >= boxes[0]['y']+boxes[0]['height']
Path('/tmp/uwork-enterprise-name-browser.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
click_test('enterprise-identity-name')
until("Array.from(document.querySelectorAll('[role=menuitem]')).some(e=>e.textContent.includes('退出登录'))")
nodes=cdp('Accessibility.getFullAXTree')['nodes']
node=next(n for n in nodes if n.get('role',{}).get('value')=='menuitem' and '退出登录' in n.get('name',{}).get('value',''))
box=cdp('DOM.getBoxModel',backendNodeId=node['backendDOMNodeId'])['model']['content']
click_at_xy(sum(box[0::2])/4,sum(box[1::2])/4)
until("!!document.querySelector('[data-testid=enterprise-identity-entry]')")
target=new_tab('http://127.0.0.1:15490/?readonly=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=workspace-mode-header]')")
assert not read("!!document.querySelector('[data-testid=enterprise-login-page]')")
assert not read("!!document.querySelector('[data-testid=enterprise-identity-entry]')")
target=new_tab('http://127.0.0.1:15490/?configured=1&dark=1&en=1&longname=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-login-page]')")
assert 'Sign in with WeCom' in read('document.body.innerText')
click_test('enterprise-wecom-login')
until("!!document.querySelector('[data-testid=enterprise-identity-name]')")
assert read('document.documentElement.scrollWidth <= innerWidth')
Path('/tmp/uwork-enterprise-name-dark-browser.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
target=new_tab('http://127.0.0.1:15490/?configured=1&native=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-wecom-login]') && !document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
click_test('enterprise-wecom-login')
until("!!document.querySelector('[data-testid=enterprise-identity-name]')")
target=new_tab('http://127.0.0.1:15490/?configured=1&native=1&cancel=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-wecom-login]') && !document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
click_test('enterprise-wecom-login')
until("document.documentElement.dataset.nativeOpened==='true' && !!document.querySelector('[data-testid=enterprise-login-qr-surface]')")
assert not read("!!document.querySelector('[data-testid=enterprise-identity-name]')")
click_test('enterprise-login-skip')
until("!document.querySelector('[data-testid=enterprise-login-page]')")
assert not read("!!document.querySelector('[data-testid=enterprise-identity-name]')")
target=new_tab('http://127.0.0.1:15490/?configured=1&native=1&scan=1&dark=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-wecom-login]') && !document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
click_test('enterprise-wecom-login')
until("document.documentElement.dataset.nativeOpened==='true'")
assert read("!!document.querySelector('[data-testid=enterprise-login-qr-surface]')")
Path('/tmp/uwork-enterprise-inline-scan-dark.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
cdp('Emulation.setDeviceMetricsOverride',width=360,height=740,deviceScaleFactor=1,mobile=False)
until("Number(document.documentElement.dataset.nativeUpdates)>0")
surface=json.loads(read('document.documentElement.dataset.nativeSurface'))
assert surface['bounds']['width'] > 0
assert surface['bounds']['x'] + surface['bounds']['width'] <= 360
rectangles=read("JSON.stringify(['enterprise-login-qr-surface','enterprise-login-skip'].map(id=>document.querySelector('[data-testid='+id+']').getBoundingClientRect().toJSON()))")
rectangles=json.loads(rectangles)
assert rectangles[0]['y']+rectangles[0]['height'] <= rectangles[1]['y']
click_test('enterprise-login-skip')
until("!document.querySelector('[data-testid=enterprise-login-page]')")
print('PASS: skip, reopen, Escape, drafts, responsive login, name, logout, attachment and inline callback/cancel/resize')
target=new_tab('http://127.0.0.1:15490/?configured=1&native=1&native_fail=1')
activate_tab(target)
wait_for_load()
until("!!document.querySelector('[data-testid=enterprise-wecom-login]') && !document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
click_test('enterprise-wecom-login')
until("document.documentElement.dataset.nativeOpened==='true' && !!document.querySelector('[data-testid=enterprise-wecom-login]') && !document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
assert not read("!!document.querySelector('[data-testid=enterprise-login-qr-surface]')")
assert read("!!document.querySelector('[role=alert]')")
click_test('enterprise-login-skip')
until("!document.querySelector('[data-testid=enterprise-login-page]')")
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
