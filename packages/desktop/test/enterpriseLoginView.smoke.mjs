// 用 Electron 的真实内嵌 view 和 302 导航验证回调桥，协议响应为 fixture，不执行真实企业微信登录。
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import {
  openEnterpriseLoginView,
  cancelEnterpriseLoginView,
  updateEnterpriseLoginView,
} from "../src/main/enterpriseLoginView.ts";

const data = await mkdtemp(join(tmpdir(), "uwork-native-identity-"));
app.setName("UWork Identity View Test");
app.setPath("userData", data);
let redirect = null;
let iframeMode = false;
let callbackLoads = 0;
let layoutMode = false;
let modernLayoutMode = false;
app.on("session-created", (session) => {
  session.protocol.handle("https", (request) => {
    if (modernLayoutMode)
      return new Response(
        `<html><body class="wwLogin_standalone"><div id="app"><div class="wwLogin_frame"><div class="wwLogin_panel"><div class="wwLogin_content"><div class="wwLogin_qrcode">
<header class="wwLogin_panel_header"><h2 class="wwLogin_panel_header_title">Vendor decoration</h2></header>
<div class="wwLogin_qrcode_head"><h2>Vendor scanner heading</h2></div>
<section class="wwLogin_qrcode_content"><div class="wwLogin_qrcode_box"><svg class="wwLogin_qrcode_img" width="192" height="192"><rect width="192" height="192" fill="black"/></svg><div class="wwLogin_qrcode_tips" hidden><span>Expired fixture</span><a href="#refresh">Refresh fixture</a></div></div></section>
<div class="wwLogin_qrcode_desc">Confirm scanner fixture</div></div></div></div><footer class="wwLogin_frame_footer">Vendor footer</footer></div></div>
<style>body{margin:0;background:#eee}.wwLogin_standalone .wwLogin_frame{padding-top:120px}.wwLogin_panel{width:480px;height:480px;margin:0 auto;background:white;border:1px solid #ddd;border-radius:8px}.wwLogin_content{display:flex;justify-content:center;height:100%;width:100%}.wwLogin_qrcode{position:relative;width:100%}.wwLogin_panel_header{padding:18px 24px;border-bottom:1px solid #ddd}.wwLogin_panel_header_title{margin:0;line-height:28px}.wwLogin_qrcode_head{display:flex;justify-content:center;height:24px;padding:40px 0}.wwLogin_qrcode_head h2{margin:0;line-height:24px}.wwLogin_qrcode_content{display:flex;justify-content:center}.wwLogin_qrcode_box{position:relative;display:inline-flex;padding:8px;background:white;border:1px solid #eee;border-radius:8px;box-sizing:border-box}.wwLogin_qrcode_img{display:block;width:192px;height:192px}.wwLogin_qrcode_desc{margin-top:24px;line-height:20px;text-align:center}.wwLogin_qrcode_tips{position:absolute;inset:0;background:white;align-items:center;justify-content:center}.wwLogin_qrcode_tips:not([hidden]){display:flex}.wwLogin_frame_footer{margin-top:40px}</style></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (layoutMode) {
      const nested = new URL(request.url).pathname === "/layout-frame";
      return new Response(
        nested
          ? '<html><body><div class="loginPanel"><div class="title">Vendor decoration</div><div class="wrp_code"><svg class="qrcode" width="320" height="320"><rect width="320" height="320" fill="black"/></svg></div><div class="status">Confirm scanner fixture</div></div><style>body{margin:0;background:white}.loginPanel{width:500px;margin:120px auto 0;padding:40px;background:white}.title{font-size:30px;height:80px}.qrcode{display:block;margin:auto}</style></body></html>'
          : '<html><body><div style="padding:100px;min-width:800px"><h1>Outer decoration</h1><iframe src="https://open.work.weixin.qq.com/layout-frame" width="500" height="600"></iframe></div></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    }
    if (new URL(request.url).hostname === "auth.example.com") {
      callbackLoads++;
      return new Response("Callback fixture loaded");
    }
    if (iframeMode && new URL(request.url).pathname === "/wwlogin/sso/login")
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
        surface: {
          bounds: { x: 50, y: 50, width: 280, height: 320 },
          appearance: {
            backgroundColor: "rgb(43,43,43)",
            foregroundColor: "rgb(230,230,230)",
            fontFamily: "Inter, sans-serif",
            fontSize: 14,
          },
        },
      };
    };
    const valid = createRequest();
    redirect = `${valid.callbackUrl}?code=fixture-code&state=${valid.id}`;
    assert.equal(await openEnterpriseLoginView({ sender: owner.webContents }, valid), redirect);
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
      await openEnterpriseLoginView({ sender: owner.webContents }, compatible),
      redirect,
    );
    assert.equal(callbackLoads, 0, "绑定的 iframe 回调不能先加载网页消费 code");
    iframeMode = false;
    const wrong = createRequest();
    redirect = `${wrong.callbackUrl}?code=fixture-code&state=wrong`;
    await assert.rejects(openEnterpriseLoginView({ sender: owner.webContents }, wrong));
    const blocked = createRequest();
    redirect = "https://attacker.example/callback?code=fixture-code";
    await assert.rejects(openEnterpriseLoginView({ sender: owner.webContents }, blocked));
    redirect = null;
    const cancel = createRequest();
    const result = openEnterpriseLoginView({ sender: owner.webContents }, cancel);
    cancelEnterpriseLoginView(owner.webContents.id + 999, cancel.id);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(owner.contentView.children.length, 1);
    cancelEnterpriseLoginView(owner.webContents.id, cancel.id);
    assert.equal(await result, null);
    assert.equal(owner.contentView.children.length, 0);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    const styled = createRequest();
    owner.show();
    owner.webContents.setZoomFactor(1.25);
    const styleResult = openEnterpriseLoginView({ sender: owner.webContents }, styled);
    const guest = owner.contentView.children[0].webContents;
    await new Promise((done) => guest.once("did-finish-load", done));
    const assertTheme = async () => {
      await guest.executeJavaScript(
        `new Promise(resolve => { const check = () => { if (getComputedStyle(document.body).backgroundColor === 'rgb(43, 43, 43)') resolve(true); else requestAnimationFrame(check); }; check(); })`,
      );
      assert.equal(guest.getZoomFactor(), 1.25);
      assert.equal(
        await guest.executeJavaScript("getComputedStyle(document.body).fontSize"),
        "14px",
      );
    };
    await assertTheme();
    console.log("PASS: initial view theme and zoom");
    await guest.loadURL("https://open.work.weixin.qq.com/fixture-next");
    await assertTheme();
    console.log("PASS: navigated view theme and zoom");
    updateEnterpriseLoginView(owner.webContents.id, { id: styled.id, surface: null });
    assert.equal(owner.contentView.children[0].getVisible(), false);
    updateEnterpriseLoginView(owner.webContents.id, { id: styled.id, surface: styled.surface });
    assert.equal(owner.contentView.children[0].getVisible(), true);
    cancelEnterpriseLoginView(owner.webContents.id, styled.id);
    assert.equal(await styleResult, null);
    owner.webContents.setZoomFactor(1);
    layoutMode = true;
    console.log("CHECK: nested frame layout");
    const layout = createRequest();
    const layoutResult = openEnterpriseLoginView({ sender: owner.webContents }, layout);
    const layoutGuest = owner.contentView.children[0].webContents;
    await new Promise((done) => layoutGuest.once("did-finish-load", done));
    const frame = layoutGuest.mainFrame.frames[0];
    assert.ok(frame);
    const boxes = await frame.executeJavaScript(
      `new Promise(resolve => { const read=()=>{ const q=document.querySelector('.qrcode'), t=document.querySelector('.title'), s=document.querySelector('.status'); const qr=q.getBoundingClientRect(), sr=s.getBoundingClientRect(); if(getComputedStyle(t).display==='none') resolve({qr:qr.toJSON(),status:sr.toJSON(),width:innerWidth,height:innerHeight}); else requestAnimationFrame(read); }; read(); })`,
    );
    assert.ok(Math.abs(boxes.qr.x + boxes.qr.width / 2 - boxes.width / 2) < 2);
    assert.ok(boxes.qr.y >= 0 && boxes.qr.bottom <= boxes.height);
    assert.ok(boxes.status.height > 0 && boxes.status.bottom <= boxes.height);
    cancelEnterpriseLoginView(owner.webContents.id, layout.id);
    await layoutResult;
    layoutMode = false;
    modernLayoutMode = true;
    for (const zoom of [1, 1.25]) {
      owner.webContents.setZoomFactor(zoom);
      for (const width of [224, 280, 336]) {
        const modern = createRequest();
        modern.surface.bounds.width = width;
        if (width === 336) {
          modern.surface.appearance.backgroundColor = "rgb(250,250,250)";
          modern.surface.appearance.foregroundColor = "rgb(25,25,25)";
        }
        const pending = openEnterpriseLoginView({ sender: owner.webContents }, modern);
        const modernGuest = owner.contentView.children[0].webContents;
        await new Promise((done) => modernGuest.once("did-finish-load", done));
        const layout = await modernGuest.executeJavaScript(`new Promise(resolve => {
          const read = () => {
            if (!document.getElementById('uwork-enterprise-presentation')) return requestAnimationFrame(read);
            const qr=document.querySelector('.wwLogin_qrcode_img'), box=document.querySelector('.wwLogin_qrcode_box'), desc=document.querySelector('.wwLogin_qrcode_desc'), panel=document.querySelector('.wwLogin_panel');
            resolve({qr:qr.getBoundingClientRect().toJSON(),box:box.getBoundingClientRect().toJSON(),desc:desc.getBoundingClientRect().toJSON(),panel:panel.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight,background:getComputedStyle(panel).backgroundColor,header:getComputedStyle(document.querySelector('.wwLogin_panel_header')).display});
          }; read();
        })`);
        assert.ok(
          Math.abs(layout.box.x + layout.box.width / 2 - layout.width / 2) < 2,
          JSON.stringify(layout),
        );
        assert.ok(layout.box.y >= 0 && layout.box.bottom <= layout.height, JSON.stringify(layout));
        assert.ok(layout.qr.width >= 160 && layout.qr.width === layout.qr.height);
        assert.ok(layout.desc.height > 0 && layout.desc.bottom <= layout.height);
        assert.ok(Math.abs((layout.box.y + layout.desc.bottom) / 2 - layout.height / 2) < 2);
        assert.equal(layout.header, "none");
        assert.equal(layout.background, "rgba(0, 0, 0, 0)");
        const status = await modernGuest.executeJavaScript(
          `(() => { const tips=document.querySelector('.wwLogin_qrcode_tips');tips.hidden=false;const r=tips.getBoundingClientRect(),link=tips.querySelector('a').getBoundingClientRect();return {visible:getComputedStyle(tips).display!=='none',rect:r.toJSON(),link:link.toJSON(),height:innerHeight};})()`,
        );
        assert.ok(status.visible && status.rect.y >= 0 && status.rect.bottom <= status.height);
        assert.ok(status.link.width > 0 && status.link.height > 0);
        const controls = await modernGuest.executeJavaScript(
          `(() => { const header=document.querySelector('.wwLogin_panel_header'); const button=document.createElement('button');button.className='wwLogin_panel_header_operate';button.textContent='Switch fixture';header.appendChild(button);const r=button.getBoundingClientRect();return {display:getComputedStyle(header).display,width:r.width,height:r.height};})()`,
        );
        assert.ok(controls.display !== "none" && controls.width > 0 && controls.height > 0);
        cancelEnterpriseLoginView(owner.webContents.id, modern.id);
        await pending;
      }
    }
    console.log("PASS: modern standalone QR layout, theme, zoom and expiry/refresh visibility");
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
