<div align="center">
  <img src="packages/desktop/build/uwork.svg" alt="UWork" width="96" height="96" />
  <h1>UWork</h1>
  <p>Bring your own model service to everyday tasks and software development.</p>
  <p><a href="README.md">简体中文</a> · English</p>
  <p><a href="https://github.com/Jas0nxlee/UWork/tree/uwork">Source</a> · <a href="LICENSE">Apache-2.0</a></p>
</div>

UWork is an AI workspace customized from [zai-org/ZCode](https://github.com/zai-org/ZCode). This version includes a default UCAS model provider, custom model services, Assistant / Developer modes, and optional WeCom identity login. The original Zhipu / Z.ai model accounts and built-in subscription entries have been removed.

This fork is maintained independently and is not an official upstream distribution. **The default branch is `uwork`**. The `main` branch retains upstream code for comparison and future synchronization.

## Features

| Feature                | Description                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default UCAS provider  | Six initial models with a fixed name, endpoint, and Chat Completions format. Edit the API key, model parameters, and enabled states, or fetch more models.                                                                        |
| Custom model providers | Unlock the add-provider entry to configure a Base URL, API key, and API format: Chat Completions, Responses, or Anthropic Messages.                                                                                               |
| Model discovery        | Fetch model IDs and add new entries in a batch. Existing parameters, enabled states, and ordering are preserved.                                                                                                                  |
| Model configuration    | Edit context windows, output limits, input types, and reasoning options. The missing revision that prevented saving imported model settings has been fixed.                                                                       |
| Assistant / Developer  | A single button beside the UWork logo shows the current mode and switches on click. The choice is remembered. Assistant emphasizes summaries and results; Developer shows more code, commands, and change details.                |
| WeCom identity         | Scan inside the desktop login card or skip login. Verified users see their name, department, and position below UWork. Windows on the same device share one enterprise account; workspaces and unsent drafts remain window-local. |
| Enterprise gateway     | Reuses the enterprise backend (ucas-proxy): after sign-in it writes the UCAS gateway endpoint and API key, appends models allowed by the plan, and shows plan quota and request / cost / token usage under Usage stats.           |
| Workspaces and tasks   | Retains upstream projects, conversations, files, terminal, Git, plugins, MCP, skills, and subagents.                                                                                                                              |
| Updated interface      | UWork SVG wordmark, U app icon, fading UCAS background, light and dark themes, and a top-right Help menu containing only Resource Manager.                                                                                        |

Interface modes do not change tool permissions or model-service access. Official automatic updates are disabled; update this customized version by rebuilding and installing it.

## Connect a model service

1. Start the desktop app. If you do not need enterprise identity, choose **Skip login and continue**.
2. When signing in with WeCom, the client calls the enterprise backend to write the gateway endpoint and API key for the default `ucas` provider and to append the models allowed by your plan. Without an enterprise backend, or when automatic provisioning fails, open **Settings → Model Settings** and enter the API key manually. The provider's name, Base URL, and API format are fixed, and it cannot be deleted. Upgrades apply the bundled connection configuration while preserving your key and existing model parameters.
3. Use **Fetch models**, or enter a model ID manually with **Add Model**.
4. Configure parameters according to the provider's actual capabilities, then select the provider and model in chat. The six initial UCAS models and newly discovered models default to a 1M context window, text / image input, and `low` / `high` / `max` reasoning levels. These are client configuration defaults; actual capabilities depend on the service.
5. Enterprise accounts can open **Settings → Usage stats → Enterprise gateway** to review the account, gateway endpoint, plan quota, and usage, and to sync or replace the key explicitly.

### Use another model provider

**Add Provider** initially appears gray. Click it **20 consecutive times** during the same visit to Model Settings to unlock it, then click once more to open the template picker. Clicking elsewhere before unlocking resets the counter. Leaving and reopening Model Settings requires unlocking again. This is an interface rule, not an access-control mechanism.

Choose a template or create a custom provider, enter its **complete API Base URL**, matching API format, and API key, then fetch or add models.

These are fictional examples; replace them with your service's endpoints:

| API format         | Example Base URL             | Chat request path      |
| ------------------ | ---------------------------- | ---------------------- |
| Chat Completions   | `https://api.example.com/v1` | `/v1/chat/completions` |
| Responses          | `https://api.example.com/v1` | `/v1/responses`        |
| Anthropic Messages | `https://api.example.com/v1` | `/v1/messages`         |

Access to the model list does not prove that every listed model supports inference or tool calling. Check your provider's documentation and permissions, then verify with a simple conversation.

### Base URLs for custom providers

Discovery currently tries `/v1/models` for a root URL, but **does not write the discovered API prefix back to the Base URL**. If your custom provider requires `/v1` and you entered only its domain, a Chat Completions request may receive a website page instead of a model response.

Set the complete API prefix required by your custom provider, such as `https://api.example.com/v1`. The bundled UCAS endpoint already includes `/v1` and needs no manual adjustment.

## Optional WeCom login

Unauthenticated desktop users can scan inside the login card or skip login and continue. Skipping applies only to the current window; login remains available after restarting. Use the entry below the UWork wordmark to reopen login, or click your verified name to view its source and sign out.

This identity provides a local name label. It does not add account-based data isolation, cloud sync, or extra permissions. Gateway provisioning is driven by the same sign-in: the service address comes from `apiBaseUrl` in the WeCom configuration, and after sign-in the client writes the UCAS gateway endpoint, reuses or creates an enterprise API key, appends models allowed by the plan, and reads plan and usage data. An existing local API key is never overwritten automatically; use the Enterprise gateway panel to replace it explicitly. Signing in or out does not migrate, claim, or delete existing workspaces, conversations, or model settings. Sign-out clears the device identity session; the current integration does not promise server-side token revocation.

Official GitHub installers include the default public WeCom login parameters. Windows, macOS, and Linux users can scan after installation without copying a configuration file. A verified scan also provisions the gateway configuration automatically; the skippable UCAS API key dialog appears only when the enterprise backend returns no usable key. The client includes no WeCom Secret, user Token, or UCAS API key. Administrators can override the defaults with a local configuration; see [WeCom integration](docs/enterprise-identity-integration.md) for its location, interface requirements, and provisioning rules. The native scan adapter is loaded by the Desktop Local Host; ordinary Web does not enable it automatically, and mobile remote control only displays the identity of the existing desktop Host.

## Data directory

UWork keeps its own user data root at `~/.uwork` (config in `~/.uwork/v2`), fully separate from upstream ZCode's `~/.zcode`. A fresh install starts with an empty profile and nothing is migrated. Override the root with `UWORK_DATA_BASE_DIR`; `ZCODE_DATA_BASE_DIR` is accepted only as a legacy alias. See [separate data root](specs/uwork-data-root-separation.md).

## Run from source

Local build and installation validation for this customized version primarily targets **macOS Apple Silicon**. Windows, Linux, Web, and CLI entry points remain in the repository; this does not imply equivalent release validation on every platform.

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) defines the tool versions. Building native components on macOS also requires Xcode Command Line Tools. Run the following commands from the repository root.

```bash
git clone --branch uwork https://github.com/Jas0nxlee/UWork.git
cd UWork
pnpm bootstrap
UWORK_DATA_BASE_DIR="$HOME/.uwork-dev" ZCODE_SKIP_REMOTE_ASSETS=1 pnpm dev:desktop:test
```

`bootstrap` installs dependencies, prepares local runtime assets, and builds the relevant packages. It skips remote assets by default. Agent source is included in `apps/zcode-cli/`.

The development command above uses test configuration, a separate data directory, and skips remote asset preparation. This environment-variable syntax is for macOS / Linux; use the equivalent shell syntax on Windows. With mise installed, you can also run `mise install`, `mise run bootstrap`, and `mise run dev` as defined in [mise.toml](mise.toml). The `dev` task already specifies a separate data directory.

To use production service configuration, keep specifying a separate data directory:

```bash
UWORK_DATA_BASE_DIR="$HOME/.uwork-dev" pnpm dev:desktop
```

| Entry point                             | Command                        |
| --------------------------------------- | ------------------------------ |
| Desktop development                     | `pnpm dev:desktop`             |
| Desktop with test service configuration | `pnpm dev:desktop:test`        |
| Web and backend development             | `pnpm dev:web`                 |
| CLI source development                  | `pnpm --filter @zcode/cli dev` |
| Remote workspace asset preparation      | `pnpm bootstrap:with-remote`   |

`dev:desktop` uses production service configuration; `dev:desktop:test` uses test configuration. These environment names do not indicate signing, notarization, or release status.

## Build the macOS application

After setting up dependencies, build the `.app` directly without the DMG packaging step:

```bash
ZCODE_ENV=production ZCODE_TARGET_OS=mac ZCODE_TARGET_ARCH=arm64 ZCODE_SKIP_REMOTE_ASSETS=1 \
  pnpm --filter @zcode/desktop build

ZCODE_ENV=production ZCODE_TARGET_OS=mac ZCODE_TARGET_ARCH=arm64 \
  pnpm --filter @zcode/desktop exec electron-builder \
  --config electron-builder.config.js --mac --arm64 --dir
```

The output is `packages/desktop/dist/mac-arm64/UWork.app`. Quit the old application and back up or move `/Applications/UWork.app` before installing your build:

```bash
ditto packages/desktop/dist/mac-arm64/UWork.app /Applications/UWork.app
xattr -cr /Applications/UWork.app
codesign --force --deep --sign - /Applications/UWork.app
codesign --verify --deep --strict /Applications/UWork.app
open /Applications/UWork.app
```

This is local ad hoc signing, not Apple Developer ID signing or notarization. Use these attribute-cleanup and signing commands only for an application you built yourself.

For DMG / ZIP output, use the full packaging entry point:

```bash
ZCODE_ENV=production ZCODE_SKIP_REMOTE_ASSETS=1 \
  pnpm bundle:desktop -- --os mac --arch arm64
```

Run `pnpm bundle:desktop -- --help` for other platform and architecture options. Application building and installer packaging are separate steps; success in one does not verify the other.

To change the app icon, edit the [SVG source](packages/desktop/build/uwork.svg), then regenerate native icon assets:

```bash
pnpm exec electron packages/desktop/scripts/build-uwork-icons.cjs
```

## Web and CLI

`pnpm dev:web` starts the frontend and backend. The default browser address is `http://localhost:5173`; the backend defaults to port `3030`. To choose a workspace:

```bash
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

The unified CLI distribution builder remains available. Replace this placeholder download URL with your own hosting location:

```bash
pnpm build:zcode --base-url https://downloads.example.com/uwork/
```

Output defaults to `dist/zcode/`. The distribution command is still `zcode`: no arguments start the TUI, and `zcode --web` starts Web mode. Building does not install or replace a system CLI. Run `pnpm build:zcode --help` for options.

## Data and network boundaries

- Internal names such as `@zcode/*`, `ZCODE_*`, the `zcode` command, and `.zcode` data directories are retained for compatibility.
- The packaged macOS application preserves the previous Electron userData location. Renaming the app does not intentionally migrate or clear provider and conversation data.
- Historical Zhipu / Z.ai model-account credentials are no longer used to restore login. Optional enterprise identity uses separate credentials and a device session. Remote connections and MCP retain their own authentication.
- This is not a fully offline edition. Model requests go to your configured provider; plugins, remote workspaces, diagnostics, and other services have their own network behavior. Never commit real API keys, configuration, logs, or conversations to a public repository.

See [NOTICE.md](NOTICE.md) for execution and data-handling details. Assistant / Developer modes are not operating-system sandboxes or permission levels.

## Development checks

```bash
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm architecture:check --changed
pnpm exec tsx --test packages/services/test/providerModelDiscovery.test.ts packages/services/test/customProvidersOnly.test.ts
pnpm exec tsx --test packages/services/test/enterpriseIdentity*.test.ts
pnpm exec tsx --test packages/services/test/ucasGateway*.test.ts
```

Test entry points and environment dependencies are defined by each package's `package.json` and test files. The Node tests above use local test data to check model discovery, UCAS configuration, enterprise gateway provisioning, and identity lifecycle; they do not establish real inference or WeCom authentication.

The [enterprise identity Electron E2E script](packages/desktop/test/enterpriseIdentity.e2e.mjs) targets an isolated source instance without authentication-service configuration. It covers startup, skipping, reopening, Esc, mode switching, and reload. Launch that instance separately and set `ZCODE_E2E_CDP_URL` to its local debugging endpoint. The [shared UI E2E](packages/ui/test/enterpriseIdentity.e2e.mjs) uses a test adapter and requires browser-harness. Real scanning and server-side session refresh need separate validation.

## Source layout and design notes

| Directory                                            | Responsibility                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and desktop packaging             |
| `packages/ui`                                        | Shared React UI, hooks, and state                                |
| `packages/services`                                  | Business services and persistence                                |
| `packages/provider`, `packages/provider-node`        | Provider configuration, model registry, and Node implementations |
| `packages/web`, `packages/server`                    | Web client and HTTP / WebSocket services                         |
| `packages/shared`, `packages/rpc`, `packages/client` | Protocols, RPC, and Agent client                                 |
| `apps/zcode-cli`                                     | Agent, TUI, tools, and execution runtime                         |

- [Custom providers and account removal](specs/custom-providers-only.md)
- [Model discovery and parameter editing](specs/provider-model-discovery.md)
- [Default UCAS provider and add-provider rules](specs/ucas-default-provider.md)
- [Optional enterprise identity and cross-window sync](specs/enterprise-identity.md) · [Authentication-service integration](docs/enterprise-identity-integration.md)
- [Enterprise gateway provisioning, plans, and usage](specs/enterprise-gateway-provisioning.md)
- [UWork branding, mode switching, and interface rules](specs/uwork-branding.md)
- [UI design system](DESIGN.md) · [Development conventions](AGENTS.md)

For troubleshooting, record your operating system, commit version, API format, redacted endpoint path, and reproduction steps. Do not include real credentials.

## Upstream and license

Thanks to [ZCode](https://github.com/zai-org/ZCode) and its contributors for the foundation. UWork customizations are maintained on this fork's `uwork` branch and do not represent upstream product features, services, or support commitments.

First-party code is licensed under [Apache License 2.0](LICENSE). Original attribution and third-party license notices are retained in [NOTICE.md](NOTICE.md), [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and the [third-party materials guide](third-party/).
