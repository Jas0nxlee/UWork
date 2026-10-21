import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = resolve(import.meta.dirname, "../../..");
const version = "99.8.7-login-fixture";
const server = await createServer({
  configFile: false,
  root: resolve(import.meta.dirname, "enterprise-identity"),
  plugins: [react(), tailwindcss()],
  define: { __ZCODE_VERSION__: JSON.stringify(version) },
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  server: { host: "127.0.0.1", port: 15492, strictPort: true, fs: { allow: [root] } },
});
await server.listen();
const code = String.raw`
import base64, json, time
from pathlib import Path
out=Path('/tmp/uwork-login-version-e2e')
out.mkdir(exist_ok=True)
recording=start_recording('uwork-login-version',title='UWork login version footer')
print({'recording':str(recording)})
def until(expression):
    for _ in range(100):
        if js(expression): return
        time.sleep(.1)
    raise AssertionError(expression)
def check_footer(label):
    until("!!document.querySelector('[data-testid=enterprise-login-page]')")
    footer=js("document.querySelector('[data-testid=enterprise-login-version]')?.textContent")
    assert footer==label+' v99.8.7-login-fixture', footer
    geometry=js("(()=>{const f=document.querySelector('[data-testid=enterprise-login-version]').getBoundingClientRect(),c=document.querySelector('[data-testid=enterprise-login-card]').getBoundingClientRect();return {footer:f.toJSON(),card:c.toJSON(),width:innerWidth,scrollWidth:document.documentElement.scrollWidth}})()")
    assert geometry['footer']['top']>=geometry['card']['bottom'], geometry
    assert geometry['scrollWidth']<=geometry['width'], geometry
    assert geometry['footer']['left']>=0 and geometry['footer']['right']<=geometry['width'], geometry
    js("document.querySelector('[data-testid=enterprise-login-version]').scrollIntoView({block:'end'})")
    until("(()=>{const r=document.querySelector('[data-testid=enterprise-login-version]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1})()")
    return geometry
def click_test(testid):
    until("(()=>{const e=document.querySelector('[data-testid="+testid+"]');if(!e)return false;const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()")
    rect=js("document.querySelector('[data-testid="+testid+"]').getBoundingClientRect().toJSON()")
    print({'click':testid,'rect':rect,'hit':js("document.elementFromPoint("+str(rect['x']+rect['width']/2)+","+str(rect['y']+rect['height']/2)+")?.outerHTML.slice(0,200)")})
    click_at_xy(rect['x']+rect['width']/2,rect['y']+rect['height']/2)
results=[]
try:
    for english in [False,True]:
        for dark in [False,True]:
            for width,height in [(320,480),(390,844),(1440,900)]:
                new_tab('http://127.0.0.1:15492/?'+('en=1&' if english else '')+('dark=1' if dark else ''))
                wait_for_load()
                cdp('Emulation.setDeviceMetricsOverride',width=width,height=height,deviceScaleFactor=1,mobile=False)
                label='Client version' if english else '客户端版本'
                geometry=check_footer(label)
                name=f"{'en' if english else 'zh'}-{'dark' if dark else 'light'}-{width}"
                (out/(name+'.png')).write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
                results.append({'case':name,'geometry':geometry})
    new_tab('http://127.0.0.1:15492/?configured=1&native=1&scan=1')
    wait_for_load()
    cdp('Emulation.setDeviceMetricsOverride',width=320,height=480,deviceScaleFactor=1,mobile=False)
    until("!!document.querySelector('[data-testid=enterprise-wecom-login]') && !document.querySelector('[data-testid=enterprise-wecom-login]').disabled")
    (out/'scan-before.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    click_test('enterprise-wecom-login')
    until("!!document.querySelector('[data-testid=enterprise-login-qr-surface]')")
    results.append({'case':'scan-short-window','geometry':check_footer('客户端版本')})
    js("document.querySelector('[data-testid=enterprise-login-skip]').scrollIntoView({block:'center'})")
    click_test('enterprise-login-skip')
    until("!document.querySelector('[data-testid=enterprise-login-page]')")
    click_test('enterprise-identity-entry')
    check_footer('客户端版本')
    (out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    print({'passed':len(results),'output':str(out)})
except:
    print(js("({height:innerHeight,content:document.querySelector('[data-testid=enterprise-login-page]')?.getBoundingClientRect().toJSON(),footer:document.querySelector('[data-testid=enterprise-login-version]')?.getBoundingClientRect().toJSON()})"))
    (out/'failure.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    raise
finally:
    stop_recording()
    for target in cdp('Target.getTargets')['targetInfos']:
        if target.get('url','').startswith('http://127.0.0.1:15492/'):
            cdp('Target.closeTarget',targetId=target['targetId'])
`;
try {
  await new Promise((done, reject) => {
    const child = spawn("browser-harness", [], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(code);
    child.on("error", reject);
    child.on("exit", (status) =>
      status === 0 ? done() : reject(new Error(`Login version E2E failed: ${status}`)),
    );
  });
} finally {
  await server.close();
}
