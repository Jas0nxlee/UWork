// Manual test entry: reuse the production managed-host fixture; never load user documents.
import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { managedEnvironment } from "../../../packages/desktop/scripts/mcp-apps-host-fixture/managed-environment.js";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../../packages/desktop/src/main/pluginSandbox/index.js";
const [output, root, node, sample, python] = process.argv.slice(2) as string[];
app.setPath("userData", join(output!, "isolated-profile"));
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
const externalAttempts: string[] = [];
app.on("session-created", (sess) =>
  sess.webRequest.onBeforeRequest((details, done) => {
    const outside =
      /^https?:/.test(details.url) &&
      !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(details.url);
    if (outside) externalAttempts.push(details.url);
    done({ cancel: outside });
  }),
);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const env = await managedEnvironment(
      output!,
      node!,
      join(root!, "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
    );
    const checks: string[] = [];
    const approved: any[] = [];
    try {
      env.agent.client.onRequest((request) => {
        if (request.method === "interaction/requestPermission") {
          const input = (request.params as any)?.input;
          const toolName = String((request.params as any)?.toolName ?? "");
          approved.push({ toolName, input });
          // 测试会话仅包含 office 插件，所有文档写入都严格限于本次 .tmp 合成文件。
          if (
            /docx_(current_target|revisions_list|revisions_resolve|comments_list)$/.test(
              toolName,
            ) &&
            (input?.path === sample || (toolName.endsWith("docx_current_target") && !input?.path))
          )
            void env.agent.respond(request, "allow");
          else void env.agent.respond(request, "deny");
        }
      });
      const workspacePath = output!,
        workspace = { workspacePath, workspaceKey: workspacePath };
      const py = `import sys;sys.path.insert(0,${JSON.stringify(join(root!, "plugins/office-editor/server"))});import server;server.remember_target(${JSON.stringify(sample)});raise SystemExit(server.main())`;
      const response = await env.agent.call("session/create", {
        workspace,
        mode: "build",
        persistence: "deferred",
        titleGenerationEnabled: false,
        mcpServers: [
          {
            name: "office",
            command: python,
            args: ["-c", py],
            env: [],
            protocolVersion: "legacy",
            isolation: "session",
          },
        ],
      });
      const scope = {
        workspace,
        sessionId: response.session.sessionId,
        pluginId: "fixture",
        serverName: "office",
        resourceUri: "ui://office-editor/editor.html",
        surface: "same",
      };
      const win = await env.createWindow(scope, "office");
      win.setSize(1300, 950);
      const page = (code: string) => env.evalPage(win, code);
      const wait = (expression: string) =>
        page(
          `new Promise((resolve,reject)=>{const t=setTimeout(()=>{o.disconnect();reject(new Error('DOM timeout: '+${JSON.stringify(expression)}))},15000);const check=()=>{if(${expression}){clearTimeout(t);o.disconnect();resolve(true)}};const o=new MutationObserver(check);o.observe(document.documentElement,{subtree:true,childList:true,attributes:true});check()})`,
        );
      await wait(`document.querySelectorAll('#list > li').length===2`);
      assert.equal(
        (await win.webContents.executeJavaScript("window.managedState()")).phase,
        "running",
      );
      assert.equal(await page("document.getElementById('file').textContent"), sample);
      assert.equal(
        await page("document.querySelector('[data-rev-id=\"101\"] button').disabled"),
        false,
      );
      checks.push(
        "real production PluginUiCard/sandbox/CLI/stdio App handshake and 2 revision cards",
      );
      await writeFile(
        join(output!, "01-before-review.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      const guest = env.guests.get(win.webContents.id)!;
      guest.debugger.attach("1.3");
      const click = async (selector: string) => {
        const p = await page(
          `(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...p,
          button: "left",
          clickCount: 1,
        });
        await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...p,
          button: "left",
          clickCount: 1,
        });
      };
      await win.webContents.executeJavaScript("window.setAnchors(false,true)");
      await wait(
        `document.getElementById('editor-status').textContent.includes('已回落到只读预览')&&document.querySelectorAll('#doc-body .docx').length>0&&document.getElementById('preview-status').textContent.includes('已渲染')`,
      );
      assert.equal(await page("document.getElementById('editor-save').disabled"), true);
      assert.equal(
        await page("document.querySelectorAll('#doc-body [contenteditable=true]').length"),
        0,
      );
      checks.push(
        "fullscreen original host mode renders DOCX read-only with empty engine config, Save disabled",
      );
      await page("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await writeFile(
        join(output!, "preview-layout.json"),
        JSON.stringify(
          await page(
            `(()=>({text:document.getElementById('doc-body').innerText,nodes:[...document.querySelectorAll('#doc-preview,#doc-body,#doc-body .docx-wrapper,#doc-body .docx,#doc-body .docx p')].map(n=>({tag:n.tagName,id:n.id,class:n.className,style:n.getAttribute('style'),rect:n.getBoundingClientRect().toJSON(),display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility,color:getComputedStyle(n).color,overflow:getComputedStyle(n).overflow}))}))()`,
          ),
          null,
          2,
        ),
      );
      await writeFile(
        join(output!, "02-readonly-docx.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      const emptyEditorHidden = await page(
        "document.getElementById('superdoc-host').hidden && getComputedStyle(document.getElementById('superdoc-host')).display==='none'",
      );
      assert.equal(
        emptyEditorHidden,
        true,
        "Unavailable SuperDoc must not leave an empty visible container",
      );
      const visibleText = await page("document.getElementById('doc-body').innerText");
      assert.ok(visibleText.includes("第一段") && visibleText.includes("插入的新句子"));
      const visiblePreview = await page(
        "(()=>{const p=document.getElementById('doc-preview');const r=p.getBoundingClientRect();return getComputedStyle(p).display!=='none'&&r.width>0&&r.height>0})()",
      );
      assert.equal(
        visiblePreview,
        true,
        "Default empty-engine DOCX preview must be actually visible, not merely present in hidden DOM",
      );
      await win.webContents.executeJavaScript("window.setAnchors(true,false)");
      await wait(`!document.body.classList.contains('wide')`);
      // 回到卡片后使用真实预览开关收起文档，使修订动作落在卡片的可见滚动区。
      await click("#preview-toggle");
      await wait(`document.getElementById('doc-preview').hidden`);
      await click('#list [data-rev-id="101"] button');
      await wait(
        `document.querySelectorAll('#list > li').length===1&&!document.querySelector('#list [data-rev-id="101"]')`,
      );
      checks.push("real Chromium click accepts insert through production MCP tool permission path");
      await click('#list [data-rev-id="102"] button:nth-of-type(2)');
      await wait(`document.querySelectorAll('#list > li').length===0`);
      checks.push(
        "real Chromium click rejects deletion through production MCP tool permission path",
      );
      await writeFile(
        join(output!, "03-after-review.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      assert.deepEqual(externalAttempts, []);
      assert.equal(
        env.model.requests.history.length,
        0,
        "No model requests are needed for deterministic office review",
      );
      const backup = (await readdir(output!)).filter(
        (p) => p.includes("_backup") && p.endsWith(".docx"),
      );
      await writeFile(
        join(output!, "results.json"),
        JSON.stringify(
          {
            checks,
            approved,
            backups: backup,
            externalAttempts,
            localModelRequests: env.model.requests.history.length,
            hostState: await win.webContents.executeJavaScript("window.managedState()"),
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({ checks, approvals: approved.length, backups: backup, externalAttempts }),
      );
    } catch (error) {
      await writeFile(
        join(output!, "failure.json"),
        JSON.stringify(
          { error: String(error), events: env.events.history.slice(-20), approvals: approved },
          null,
          2,
        ),
      );
      for (const win of env.windows) {
        if (!win.isDestroyed()) {
          await writeFile(
            join(output!, "failure-host.png"),
            (await win.webContents.capturePage()).toPNG(),
          );
          try {
            await writeFile(
              join(output!, "failure-page.txt"),
              await env.evalPage(win, "document.body.innerText"),
            );
          } catch {}
        }
      }
      throw error;
    } finally {
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
