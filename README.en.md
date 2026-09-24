<div align="center">
  <img src="packages/desktop/build/uwork.svg" alt="UWork" width="96" height="96" />
  <h1>UWork</h1>
  <p>Bring your own model service to everyday tasks and software development.</p>
  <p><a href="README.md">简体中文</a> · English</p>
  <p><a href="https://github.com/Jas0nxlee/UWork/tree/uwork">Source</a> · <a href="LICENSE">Apache-2.0</a></p>
</div>

UWork is an AI workspace customized from [zai-org/ZCode](https://github.com/zai-org/ZCode). This version centers on user-configured model providers, removes desktop account login and built-in Zhipu subscription entries, and updates branding, mode switching, and model settings.

This fork is maintained independently and is not an official upstream distribution. **The default branch is `uwork`**. The `main` branch retains upstream code for comparison and future synchronization.

## Features

| Feature                | Description                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Custom model providers | Configure a Base URL, API key, and API format: Chat Completions, Responses, or Anthropic Messages.                                                                                                                 |
| Model discovery        | Fetch model IDs and add new entries in a batch. Existing parameters, enabled states, and ordering are preserved.                                                                                                   |
| Model configuration    | Edit context windows, output limits, input types, and reasoning options. The missing revision that prevented saving imported model settings has been fixed.                                                        |
| Assistant / Developer  | A single button beside the UWork logo shows the current mode and switches on click. The choice is remembered. Assistant emphasizes summaries and results; Developer shows more code, commands, and change details. |
| Workspaces and tasks   | Retains upstream projects, conversations, files, terminal, Git, plugins, MCP, skills, and subagents.                                                                                                               |
| Updated interface      | UWork SVG wordmark, U app icon, fading UCAS background, light and dark themes, and a top-right Help menu containing only Resource Manager.                                                                         |

Interface modes do not change tool permissions or model-service access. Official automatic updates are disabled; update this customized version by rebuilding and installing it.

## Connect a model service

1. Open **Settings → Model Settings → Add Provider**, then choose a template or create a custom provider.
2. Enter the provider's **complete API Base URL**, select the matching API format, and supply your API key.
3. Use **Fetch models**, or enter a model ID manually with **Add Model**.
4. Configure parameters according to the provider's actual capabilities, then select the provider and model in chat.

These are fictional examples; replace them with your service's endpoints:

| API format         | Example Base URL             | Chat request path      |
| ------------------ | ---------------------------- | ---------------------- |
| Chat Completions   | `https://api.example.com/v1` | `/v1/chat/completions` |
| Responses          | `https://api.example.com/v1` | `/v1/responses`        |
| Anthropic Messages | `https://api.example.com/v1` | `/v1/messages`         |

Access to the model list does not prove that every listed model supports inference or tool calling. Check your provider's documentation and permissions, then verify with a simple conversation.

### Known issue: discovery succeeds but chat returns no content

Discovery currently tries `/v1/models` for a root URL, but **does not write the discovered API prefix back to the Base URL**. If your provider requires `/v1` and you entered only its domain, a Chat Completions request may receive a website page instead of a model response.

Set the complete API prefix required by your provider, such as `https://api.example.com/v1`. A code fix to keep discovery and chat paths consistent is not included in the current version.

## Run from source

This customized version has been built and visually checked on **macOS Apple Silicon**. Windows, Linux, Web, and CLI entry points remain in the repository; this does not imply equivalent release validation on every platform.

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) defines the tool versions. Building native components on macOS also requires Xcode Command Line Tools. Run the following commands from the repository root.

```bash
git clone --branch uwork https://github.com/Jas0nxlee/UWork.git
cd UWork
pnpm bootstrap
pnpm dev:desktop
```

`bootstrap` installs dependencies, prepares local runtime assets, and builds the relevant packages. It skips remote assets by default. Agent source is included in `apps/zcode-cli/`.

Use a separate data directory during development to keep test data apart from your regular configuration. The environment-variable syntax below is for macOS / Linux:

```bash
ZCODE_DATA_BASE_DIR="$HOME/.uwork-dev" pnpm dev:desktop
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
ZCODE_ENV=production ZCODE_SKIP_REMOTE_ASSETS=1 \
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
- Historical app-account credentials are no longer used to restore login. Removing app login does not remove remote-connection or MCP authentication.
- This is not a fully offline edition. Model requests go to your configured provider; plugins, remote workspaces, diagnostics, and other services have their own network behavior. Never commit real API keys, configuration, logs, or conversations to a public repository.

See [NOTICE.md](NOTICE.md) for execution and data-handling details. Assistant / Developer modes are not operating-system sandboxes or permission levels.

## Development checks

```bash
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm exec tsx --test packages/services/test/*.test.ts
pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/*.test.ts
```

The [Electron E2E script](packages/desktop/test/uwork.e2e.mjs) covers mode switching, discovery, deduplication, error handling, and editing imported models. First launch a source build with isolated data directories, then set `ZCODE_E2E_CDP_URL` to its local debugging endpoint. The test creates providers; do not connect it to your everyday configuration.

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
- [UWork branding, mode switching, and interface rules](specs/uwork-branding.md)
- [UI design system](DESIGN.md) · [Development conventions](AGENTS.md)

For troubleshooting, record your operating system, commit version, API format, redacted endpoint path, and reproduction steps. Do not include real credentials.

## Upstream and license

Thanks to [ZCode](https://github.com/zai-org/ZCode) and its contributors for the foundation. UWork customizations are maintained on this fork's `uwork` branch and do not represent upstream product features, services, or support commitments.

First-party code is licensed under [Apache License 2.0](LICENSE). Original attribution and third-party license notices are retained in [NOTICE.md](NOTICE.md), [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and the [third-party materials guide](third-party/).
