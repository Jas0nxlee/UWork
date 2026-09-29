// 用 Electron 的真实窗口和 302 导航验证回调桥，协议响应为 fixture，不执行真实企业微信登录。
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import {
  openEnterpriseLoginWindow,
  cancelEnterpriseLoginWindow,
} from "../src/main/enterpriseLoginWindow.ts";

const data = await mkdtemp(join(tmpdir(), "uwork-native-identity-"));
app.setName("UWork Identity Window Test");
app.setPath("userData", data);
let redirect = null;
let iframeMode = false;
let callbackLoads = 0;
app.on("session-created", (session) => {
  session.protocol.handle("https", (request) => {
    if (new URL(request.url).hostname === "auth.example.com") {
      callbackLoads++;
      return new Response("Callback fixture loaded");
    }
    if (iframeMode && new URL(request.url).hostname === "login.work.weixin.qq.com")
      return new Response(
        '<html><body><iframe src="https://open.work.weixin.qq.com/fixture"></iframe></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    return redirect
      ? new Response("", { status: 302, headers: { Location: redirect } })
      : new Response("<html><body>Identity fixture</body></html>", {
          headers: { "Content-Type": "text/html" },
        });
  });
});
const timer = setTimeout(() => {
  console.error("FAIL: native identity smoke timed out");
  app.exit(1);
}, 20000);
async function run() {
  try {
    await app.whenReady();
    const owner = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, sandbox: true },
    });
    await owner.loadURL("data:text/html,<body>Identity owner fixture</body>");
    const createRequest = () => {
      const id = crypto.randomUUID();
      const callbackUrl = "https://auth.example.com/callback";
      const query = new URLSearchParams({
        login_type: "CorpApp",
        appid: "wx-fixture",
        agentid: "1000001",
        state: id,
        redirect_uri: callbackUrl,
      });
      return {
        id,
        callbackUrl,
        authorizationUrl: `https://login.work.weixin.qq.com/wwlogin/sso/login?${query}`,
        expiresAt: Date.now() + 60000,
      };
    };
    const valid = createRequest();
    redirect = `${valid.callbackUrl}?code=fixture-code&state=${valid.id}`;
    assert.equal(await openEnterpriseLoginWindow({ sender: owner.webContents }, valid), redirect);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    const compatible = createRequest();
    compatible.expectedState = "fixture-org";
    compatible.callbackUrl += `?uwork_nonce=${compatible.id}`;
    const compatibleUrl = new URL(compatible.authorizationUrl);
    compatibleUrl.searchParams.set("state", compatible.expectedState);
    compatibleUrl.searchParams.set("redirect_uri", compatible.callbackUrl);
    compatible.authorizationUrl = compatibleUrl.href;
    iframeMode = true;
    redirect = `${compatible.callbackUrl}&code=fixture-code&state=fixture-org`;
    assert.equal(
      await openEnterpriseLoginWindow({ sender: owner.webContents }, compatible),
      redirect,
    );
    assert.equal(callbackLoads, 0, "绑定的 iframe 回调不能先加载网页消费 code");
    iframeMode = false;
    const wrong = createRequest();
    redirect = `${wrong.callbackUrl}?code=fixture-code&state=wrong`;
    await assert.rejects(openEnterpriseLoginWindow({ sender: owner.webContents }, wrong));
    const blocked = createRequest();
    redirect = "https://attacker.example/callback?code=fixture-code";
    await assert.rejects(openEnterpriseLoginWindow({ sender: owner.webContents }, blocked));
    redirect = null;
    const cancel = createRequest();
    const result = openEnterpriseLoginWindow({ sender: owner.webContents }, cancel);
    cancelEnterpriseLoginWindow(owner.webContents.id + 999, cancel.id);
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    cancelEnterpriseLoginWindow(owner.webContents.id, cancel.id);
    assert.equal(await result, null);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    owner.destroy();
    console.log(
      "PASS: native callback interception, wrong state, blocked navigation and owner-scoped cancellation",
    );
    clearTimeout(timer);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timer);
    app.exit(1);
  }
}
// Electron 的 ready 要在入口模块求值完成后触发；不能在入口顶层 await whenReady 造成相互等待。
void run();
