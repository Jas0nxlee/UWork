// UWORK-REMOTE-01：真实 Web main → Root → 手机壳/宽屏 Sidebar 的浏览器装配回归。
// relay 响应由离线夹具提供；不连接企业微信、桌面 Host 或真实 SSH，不宣称真实配对验收。
// 运行：node packages/web/test/e2e/manual-review/pending/uwork-remote-integration.mjs
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const repoRoot = resolve(import.meta.dirname, "../../../../../..");
const artifactDir = resolve(repoRoot, ".tmp/uwork-remote-integration-e2e");
await mkdir(artifactDir, { recursive: true });

const fakeRelay = String.raw`
(() => {
  const params = new URLSearchParams(location.search);
  localStorage.setItem('zcode-theme', params.get('fixture_theme') || 'zai-light');
  const fixture = window.__uworkRemoteFixture = { reconnects: 0, bridgeOpens: 0, errors: [], messages: [] };
  window.addEventListener('error', event => fixture.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason)));
  const NativeWebSocket = window.WebSocket;
  const workspace = {
    workspacePath: '/workspace/uwork-remote-fixture',
    workspaceIdentity: 'remote:ssh:fixture:/workspace/uwork-remote-fixture',
    label: 'UWORK_REMOTE_FIXTURE', kind: 'remote', connectionState: 'disconnected',
  };
  const tasks = [{
    taskId:'fixture-task', title:'UWORK_REMOTE_TASK', workspacePath:workspace.workspacePath,
    workspaceIdentity:workspace.workspaceIdentity, workspaceLabel:workspace.label,
    workspaceKind:'remote', createdAt:1, updatedAt:1, provider:'glm',
  }];
  class OfflineRelay extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; extensions = ''; bufferedAmount = 0;
    constructor(url, protocols) {
      super();
      if (new URL(url).pathname !== '/ws') return new NativeWebSocket(url, protocols);
      setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0);
    }
    reply(message) {
      setTimeout(() => this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(message)})), 0);
    }
    send(raw) {
      const message = JSON.parse(raw);
      fixture.messages.push({type:message.type, payloadType:message.payload?.zcode_type});
      if (message.type === 'auth_init') this.reply({type:'auth_challenge', nonce:'uwork-fixture-nonce'});
      if (message.type === 'auth_response') this.reply({type:'auth_ack', device_sid:'uwork-fixture', pair_status:'matched'});
      if (message.type === 'pair_status_query') this.reply({type:'pair_status_ack', pair_status:'matched'});
      if (message.type === 'ping') this.reply({type:'pong'});
      const p = message.payload;
      if (p?.zcode_type === 'bootstrap-request') this.reply({type:'data', payload:{
        zcode_type:'bootstrap-response', requestId:p.requestId, success:true,
        result:{windowControlSessionId:'uwork-fixture', desktopAppVersion:'3.16.0', workspaces:[workspace], tasks},
      }});
      if (p?.zcode_type === 'workspace-list-request') this.reply({type:'data', payload:{
        zcode_type:'workspace-list-response', requestId:p.requestId, success:true,
        result:{workspaces:[workspace], tasks},
      }});
      if (p?.zcode_type === 'workspace-bridge-open') fixture.bridgeOpens++;
      if (p?.zcode_type === 'workspace-reconnect-request') {
        fixture.reconnects++;
        this.reply({type:'data', payload:{zcode_type:'workspace-reconnect-response',
          requestId:p.requestId, workspaceKey:p.workspaceKey, success:false, error:'Fixture desktop remains offline',
        }});
      }
    }
    close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', {code:1000})); }
  }
  window.WebSocket = OfflineRelay;
})();
`;

const server = await createServer({
  root: resolve(repoRoot, "packages/web"),
  configFile: resolve(repoRoot, "packages/web/vite.config.ts"),
  base: "/remote/v4/",
  plugins: [
    {
      name: "uwork-offline-relay-fixture",
      transformIndexHtml: () => [{ tag: "script", children: fakeRelay, injectTo: "head-prepend" }],
    },
  ],
  server: { host: "127.0.0.1", port: 15493, strictPort: true },
});
await server.listen();

const code = String.raw`
import json, time, base64
from pathlib import Path
artifacts = Path(${JSON.stringify(artifactDir)})
def until(expression):
    for _ in range(180):
        if js(expression): return
        time.sleep(.2)
    print(page_info())
    print(js('document.body.innerText'))
    print(js('window.__uworkRemoteFixture'))
    (artifacts / 'failure.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    raise AssertionError(expression)
for width, theme in [(390,'zai-light'), (390,'zai-dark'), (1200,'zai-light'), (1200,'zai-dark')]:
    target = new_tab('about:blank')
    # Chrome 已实测在 hidden 标签节流本夹具的 relay timers，必须前台运行才能验证点击后的应答。
    activate_tab(target)
    cdp('Emulation.setDeviceMetricsOverride', width=width, height=844, deviceScaleFactor=1, mobile=width<768)
    goto_url('http://127.0.0.1:15493/remote/v4/?sid=uwork-fixture&hash=fixture-hash&t=1&mid=fixture-mid&app_version=3.16.0&fixture_theme='+theme)
    wait_for_load()
    until("document.body.innerText.includes('UWORK_REMOTE_FIXTURE')")
    assert not js("!!document.querySelector('[data-testid=onboarding-page]')")
    assert not js("!!document.querySelector('[data-testid=enterprise-login-page]')")
    assert not js("!!document.querySelector('[data-testid=enterprise-identity-entry]')")
    assert not js("!!document.querySelector('[data-testid=automations-open]')")
    assert js('document.documentElement.scrollWidth <= innerWidth'), width
    assert js('window.__uworkRemoteFixture.bridgeOpens') == 0
    assert js('window.__uworkRemoteFixture.errors') == [], js('window.__uworkRemoteFixture.errors')
    if width < 768:
        # 使用辅助功能树定位真实重连按钮，再通过坐标点击；失败由既有桌面连接 owner 返回。
        nodes=cdp('Accessibility.getFullAXTree')['nodes']
        matches=[n for n in nodes if n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value') in ['Reconnect','重新连接','重连']]
        assert len(matches)==1, [(n.get('name',{}).get('value')) for n in nodes if n.get('role',{}).get('value')=='button']
        q=cdp('DOM.getBoxModel', backendNodeId=matches[0]['backendDOMNodeId'])['model']['content']
        click_at_xy(sum(q[0::2])/4, sum(q[1::2])/4)
        until('window.__uworkRemoteFixture.reconnects === 1')
        assert js('window.__uworkRemoteFixture.bridgeOpens') == 0
    else:
        assert js("!!document.querySelector('[data-web-remote-navigation-scroll=true]')")
    (artifacts / (str(width)+'-'+theme+'.png')).write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    print('PASS UWORK-REMOTE-01', width, theme)
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
