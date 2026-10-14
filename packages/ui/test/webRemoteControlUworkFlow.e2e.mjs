// UWORK-REMOTE-02：真实手机 UI 的同路径不同身份切换、聊天落点、恢复提示和身份只读初始化。
// 与 Web main 的首次 relay/home-only 场景互补；本夹具不创建 Host、Agent 或真实外部连接。
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = resolve(import.meta.dirname, "../../..");
const artifacts = resolve(repoRoot, ".tmp/uwork-remote-flow-e2e");
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  configFile: false,
  root: resolve(import.meta.dirname, "web-remote-uwork"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(repoRoot, "packages/ui/src") } },
  server: { host: "127.0.0.1", port: 15494, strictPort: true, fs: { allow: [repoRoot] } },
});
await server.listen();
const code = String.raw`
import time, base64
from pathlib import Path
artifacts = Path(${JSON.stringify(artifacts)})
target = new_tab('about:blank')
# hidden 标签的 relay/UI timers 在此前真实入口测试中已确认被 Chrome 节流，先前台再导航。
activate_tab(target)
cdp('Emulation.setDeviceMetricsOverride', width=390, height=844, deviceScaleFactor=1, mobile=True)
goto_url('http://127.0.0.1:15494/')
wait_for_load()
def until(expression):
    for _ in range(150):
        if js(expression): return
        time.sleep(.1)
    print(page_info())
    print(js('document.body.innerText'))
    raise AssertionError(expression)
def click_named(fragment):
    nodes=cdp('Accessibility.getFullAXTree')['nodes']
    candidates=[n for n in nodes if n.get('role',{}).get('value')=='button' and fragment in n.get('name',{}).get('value','')]
    assert len(candidates)==1, [(n.get('name',{}).get('value')) for n in candidates]
    q=cdp('DOM.getBoxModel', backendNodeId=candidates[0]['backendDOMNodeId'])['model']['content']
    click_at_xy(sum(q[0::2])/4, sum(q[1::2])/4)
until("document.body.innerText.includes('UWORK_TASK_A') && document.body.innerText.includes('Remote fixture')")
click_named('UWORK_TASK_A')
until("document.querySelector('[data-testid=fixture-chat]')?.dataset.taskId==='task-a'")
assert js('window.uworkRemoteUiFixture.selected.length') == 1
assert js('window.uworkRemoteUiFixture.switches.length') == 0
click_named('Back to fixture home')
until("!document.querySelector('[data-mobile-page=chat]')")
click_named('Remote fixture')
until("document.body.innerText.includes('UWORK_TASK_B')")
click_named('UWORK_TASK_B')
until("document.querySelector('[data-testid=fixture-chat]')?.dataset.taskId==='task-b'")
assert js("document.querySelector('[data-testid=fixture-chat]').dataset.workspaceIdentity")=='remote:ssh:fixture:/same/path'
switches=js('window.uworkRemoteUiFixture.switches')
assert switches==[{'workspaceKey':'remote:ssh:fixture:/same/path','options':{'taskId':'task-b','mobileNavigationIntent':'chat'}}], switches
click_named('Simulate transport recovery')
until("!!document.querySelector('[data-web-remote-control-reconnect-notice=true]')")
assert not js("!!document.querySelector('[data-testid=enterprise-login-page]')")
counts=js('window.uworkRemoteUiFixture')
assert counts['reads']>0 and counts['restores']==0 and counts['logins']==0 and counts['gatewaySyncs']==0, counts
assert js('document.documentElement.scrollWidth <= innerWidth')
(artifacts / '390-cross-workspace-recovery.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
print('PASS UWORK-REMOTE-02: current task, identity-isolated cross-workspace chat, reconnect notice, read-only identity')
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
