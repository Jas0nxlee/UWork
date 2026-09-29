// 手工真实扫码验证：使用本机公开配置，Token 仅由 Node 服务加密持久化，不写日志。
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { app, BrowserWindow } from "electron";
import { withFileLock } from "@zcode/shared/node";
import { createCredentialService } from "../../services/src/credential/credentialService.ts";
import { getAppConfigDir } from "../../services/src/paths.ts";
import {
  createEnterpriseIdentityService,
  disposeEnterpriseIdentityService,
} from "../../services/src/enterprise-identity/enterpriseIdentityService.ts";
import { createSharedIdentitySessionStore } from "../../services/src/enterprise-identity/identitySessionStore.ts";
import { loadWeComIdentityAdapter } from "../../services/src/enterprise-identity/wecomIdentityConfig.ts";
import { openEnterpriseLoginWindow } from "../src/main/enterpriseLoginWindow.ts";

const dir = await mkdtemp(join(tmpdir(), "uwork-live-identity-"));
app.setName("UWork Identity Verification");
app.setPath("userData", dir);
async function run() {
  let identity;
  try {
    await app.whenReady();
    const adapter = await loadWeComIdentityAdapter(
      join(getAppConfigDir(), "enterprise-identity.json"),
      fetch,
    );
    if (!adapter) throw new Error("Missing public enterprise configuration");
    const credentials = createCredentialService();
    identity = createEnterpriseIdentityService({
      credentials,
      adapter,
      sessionStore: createSharedIdentitySessionStore(credentials, (operation) =>
        withFileLock(join(getAppConfigDir(), "enterprise-identity-state"), operation),
      ),
    });
    const restored = await identity.restoreSession();
    if (restored.status === "authenticated") {
      console.log(
        "VERIFIED: existing enterprise session was verified by issuer; profile has a display name",
      );
      await disposeEnterpriseIdentityService(identity);
      app.exit(0);
      return;
    }
    const owner = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, sandbox: true },
    });
    await owner.loadURL("data:text/html,<body>UWork identity verification owner</body>");
    const attempt = await identity.beginLogin();
    console.log("READY: scan and confirm in the isolated UWork enterprise login window");
    const callback = await openEnterpriseLoginWindow({ sender: owner.webContents }, attempt);
    if (callback === null) {
      await identity.cancelLogin(attempt.id);
      console.log("CANCELLED: no login completed");
    } else {
      const view = await identity.completeLogin(attempt.id, callback);
      if (view.status !== "authenticated") throw new Error("Identity was not accepted");
      console.log(
        "VERIFIED: issuer code exchange and name validation succeeded; encrypted device session persisted",
      );
    }
    owner.destroy();
    await disposeEnterpriseIdentityService(identity);
    app.exit(0);
  } catch (error) {
    if (identity) await disposeEnterpriseIdentityService(identity);
    console.error(
      "FAILED: enterprise identity verification did not complete",
      error instanceof Error ? error.message : "unknown error",
    );
    app.exit(1);
  }
}
void run();
