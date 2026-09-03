# BunView - A native app using your Claude/ChatGPT subscription

A minimal desktop scaffold for a native app to connect a user's chatGPT/Claude subscription plan.

Features:

- Native app executable
- Bun server
- React frontend in WebView
- MCP App host integration
- Example MCP tool use
- Example prompt/response implementation
- Pick AI model/effort parameters

It is a starting point for your own purposes.

## Quickstart

```bash
bun install
bun run dev
## Tests
bun test
bun run typecheck
```

## How it works

User must choose which plan to connect — Claude Code or Codex.

If the agent CLI is missing, the app offers to install it, downloading the vendor's own signed binary and verifying its checksum. If it is installed but signed out, it offers a Sign in button. Once the header badge shows your plan, the composer unlocks.

The right-hand panel shows an app state the agent can write to via this app's own MCP tools.
Try: **“Set the app status to hello and add a note.”** The panel updates as it answers.

## Quick Guide Map

```
┌─ main.ts ────────────────┐        ┌─ src/server/worker.ts ──────────────┐
│ main thread              │ ready  │ Worker                              │
│ native window (webview)  │◄──────►│ Bun.serve  ─ POST /api/chat  (SSE)  │
│ webview.run() blocks     │  port  │            ─ GET  /api/auth         │
└──────────────────────────┘        │            ─ GET  /api/state        │
                                    │            ─ /*  bundled React app  │
                                    └───────────────┬─────────────────────┘
                                                    │ Agent SDK
                                                    ▼
                                          claude (native binary)
                                            reads ~/.claude/.credentials.json
                                            ← in-process MCP tools call back
```

## Providers

|                 | Claude Code      | Codex                         |
| --------------- | ---------------- | ----------------------------- |
| Runs on         | Claude Pro / Max | ChatGPT Plus / Pro / Business |
| Streaming       | token by token   | **per message**               |
| App's MCP tools | yes, in-process  | **no**                        |

Codex still requires testing and validation.

> The Codex provider is written against OpenAI's published CLI reference and has **not** been
> exercised against a real `codex` install. Its event mapping is deliberately tolerant, so an
> unverified field name degrades to "no event" rather than a crash — but treat it as untested.

**Note** Codex's own tools work fine. What is missing is _BunView's_ tools, the reason is the registration channel. The Claude Agent SDK has a bidirectional control protocol over the same stdio stream it uses to drive the CLI, so `createSdkMcpServer` registers a tool **for one session only** and the handler runs in this process. `codex exec --json` is one-way — prompt in, JSONL out — with no channel to answer on.

It is still doable: Codex reads MCP servers from `~/.codex/config.toml`, and a `url` entry there uses streamable HTTP, so BunView could serve `POST /mcp` from the Bun server it already runs and keep the tools in-process after all. The costs are what stopped it — it writes to the user's **global** config rather than being scoped to a session, it currently needs `experimental_use_rmcp_client = true`, and it means implementing the MCP wire protocol rather than calling a helper.

## Prerequisites

|             |                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Bun         | ≥ 1.3.9 (`--watch=always` is used in dev)                                                                                        |
| Claude Code | none — the app can install it. Or `curl -fsSL https://claude.ai/install.sh \| bash` / `irm https://claude.ai/install.ps1 \| iex` |
| Windows     | Nothing                                                                                                                          |
| macOS       | Nothing; WKWebView is built in                                                                                                   |
| Linux       | GTK 4 + WebKitGTK 6 — `apt install libgtk-4-1 libwebkitgtk-6.0-4` / `pacman -S gtk4 webkitgtk-6.0`                               |

Desktop only. The whole design spawns a local process, which is not supported on Android, iOS. A mobile client could use Tauri instead of Bun to get around this.

## How the agent connection works

`claude auth login` writes OAuth credentials to `~/.claude/.credentials.json` (or the OS keychain), and the agent binary reads them when the app spawns it. Usage bills against your Pro/Max quota and obeys its rate limits.

### Prevent accidental API usage

If `ANTHROPIC_API_KEY` is set in the environment, the CLI will prefer it and bills API credits instead. So [`src/server/env.ts`](src/server/env.ts) strips it (and `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, the Bedrock/Vertex switches) from the child environment. Set `BUNVIEW_ALLOW_API_KEY=1` to opt back in deliberately.

`GET /api/auth?provider=<id>` shells the vendor's status command (`claude auth status --json`, `codex login status`) and reports which credential is actually in play, so the badge says _“Claude max · you@example.com”_ on a subscription and warns _“API key — usage is billed per token”_ when it is not.

## MCP: App as the host

MCP only carries **tools**. It has no concept of a conversation, a model or a subscription, so it always needs a host that already has a model attached. This app acts as the host. The app registers its _own_ MCP server into the agent session, so the agent can call tools that change the app's live state.

[`src/server/mcp/app-tools.ts`](src/server/mcp/app-tools.ts):

```ts
export const appToolsServer = createSdkMcpServer({
  name: 'bunview',
  tools: [
    tool('set_status', '…', { text: z.string() }, async ({ text }) => ok(setStatus(text))),
    // …
  ],
})
```

`createSdkMcpServer` runs these **in this process**. The handlers close over [`src/server/state.ts`](src/server/state.ts), so a tool call mutates the same object the UI is rendering. A stdio MCP server would instead put a process boundary between the agent's tools and your app's state; an HTTP one keeps them together but means implementing the wire protocol and registering it globally.

## Forking:

Delete the three example tools and register your own.

## Safety defaults

Read-only.

| Env var                                | Default                                           | Effect                                                             |
| -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `BUNVIEW_ALLOWED_TOOLS`                | `Read,Grep,Glob,mcp__bunview__*`                  | Pre-approved, so no prompt can arise in a headless session         |
| `BUNVIEW_DISALLOWED_TOOLS`             | `Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch` | The actual fence                                                   |
| `BUNVIEW_PERMISSION_MODE`              | `default`                                         | `bypassPermissions` additionally requires `BUNVIEW_ALLOW_BYPASS=1` |
| `BUNVIEW_SETTING_SOURCES`              | _(empty)_                                         | Do not inherit the user's CLAUDE.md, skills, hooks or MCP servers  |
| `BUNVIEW_CWD`                          | `homedir()`                                       | Session bucket, and what `--restricted` confines file tools to     |
| `BUNVIEW_MODEL`                        | _(CLI default)_                                   | Also selectable per-message in the UI                              |
| `BUNVIEW_EFFORT`                       | `low`                                             | Session-scoped; never written to your config                       |
| `BUNVIEW_CLAUDE_PATH`                  | _(discovered)_                                    | Explicit path to the Claude binary                                 |
| `BUNVIEW_CODEX_PATH`                   | _(discovered)_                                    | Explicit path to the Codex binary                                  |
| `BUNVIEW_ALLOW_INSTALL`                | `1`                                               | Offer to install a missing CLI. Set `0` for managed/offline builds |
| `BUNVIEW_ALLOW_API_KEY`                | `0`                                               | Stop stripping `ANTHROPIC_API_KEY`                                 |
| `BUNVIEW_STALL_MS` / `BUNVIEW_WALL_MS` | `120000` / `600000`                               | Silence cap / total cap                                            |
| `BUNVIEW_PORT`                         | `0`                                               | `0` = ephemeral                                                    |

Two things are worth knowing about the defaults:

- **`settingSources: []` is not tidiness.** With the default, the session inherits every MCP server in the user's `~/.claude.json`. On a working developer machine that can mean Gmail, Drive and Calendar.
- **`--restricted` is passed as a hard backstop.** It removes the tools that run commands or code, confines file tools to the working directories, ignores user/project/local settings, and _refuses `bypassPermissions` outright_ — so an app built on this cannot cause harm.

**Never add `--bare`.** otherwise the sdk will use `ANTHROPIC_API_KEY` and bill based on API usage instead.

### Widening permissions scope

If your app needs to read a project directory:

```bash
BUNVIEW_ALLOWED_TOOLS="Read,Grep,Glob,mcp__bunview__*" \
BUNVIEW_CWD="/path/to/project" \
bun run dev
```

`--restricted` then confines those file tools to that directory automatically.

## Architecture notes

The webview owns the main thread. `webview.run()` runs a blocking native event loop, so a `Bun.serve` on the same thread would register with an event loop that never runs again and every request would hang. The server therefore lives in a Worker, and the two meet once, at the `{ type: 'ready', port }` handshake.

`main.ts` must stay at the repo root, and the Worker specifier must stay a string literal. Bun discovers worker modules by static analysis of `new Worker('./src/server/worker.ts')` — wrapping it in `new URL(…, import.meta.url)` silently omits the module from the compiled binary. And a plain specifier resolves against the bunfs root, which is the common ancestor of `build.ts`'s `entrypoints`; keeping `main.ts` at the root makes that the repo root so the path means the same thing in dev and in the executable.

**Events are a closed union.** [`src/shared/events.ts`](src/shared/events.ts) defines every shape the browser can see, and [`claude-map.ts`](src/server/providers/claude-map.ts) maps the agent's messages onto it, dropping anything unrecognised. That keeps an unversioned internal wire format out of the UI, keeps the provider seam real, and — importantly — keeps tool _inputs_ off the wire, since an `Edit` tool's input is file contents. Tool events carry a name and nothing else.

**Cancellation has three independent paths**: the client's `AbortController`, the server listening to both `req.signal` and the stream's `cancel()`, and a process-exit sweep in [`proc.ts`](src/server/proc.ts). The last one matters because neither `worker.terminate()` nor `process.exit()` reaps a grandchild — without it, closing the window mid-answer leaves an agent running against your plan.

**SSE, not `EventSource`.** EventSource cannot POST, cannot set headers, and auto-reconnects when the server closes the stream — which for a one-shot completion re-fires the whole prompt the moment the answer finishes.

## Onboarding: Installing agent cli and auth flow

Two endpoints reach outside the app's own process, and both are gated behind an explicit click that shows what will run first:

- **`POST /api/install`** downloads the vendor's own signed binary into BunView's data folder
  and verifies its SHA-256, streaming progress back as SSE. Afterwards it clears the discovery
  cache and re-detects, so the new binary is found without a restart.
  `BUNVIEW_ALLOW_INSTALL=0` removes the button entirely.

  What [`install/`](src/server/install/) does instead is what the vendors' own `install.sh` /
  `install.ps1` do — read the release manifest, download the platform binary, verify the
  checksum — minus the shell. No npm, no Node, no shell, no admin rights. The binaries arrive
  Developer ID-signed and Apple-notarized (they are the vendor's, unmodified), and a file
  fetched programmatically carries no `com.apple.quarantine`, so Gatekeeper does not gate it.
  BunView adds no signing obligations of its own.

  It installs to the app's data folder and **not** onto PATH — `%LOCALAPPDATA%\BunView`,
  `~/Library/Application Support/BunView`, or `$XDG_DATA_HOME/BunView`. Discovery checks it
  **last**, so a `claude` the user installed themselves stays authoritative; these tools share
  state under `~/.claude` / `~/.codex`. Uninstalling is deleting the folder.

  Nothing auto-installs.

- **`POST /api/login`** opens the vendor's sign-in command **in a real terminal window** rather
  than driving it headless through pipes. Both vendors' login flows are interactive — they open
  a browser, run a localhost callback listener, and may print a code to confirm.

## Adding a provider

Implement [`Provider`](src/server/providers/types.ts) — `detect()`, `authStatus()`, `stream()` — in a file beside `claude.ts` and `codex.ts`, add it to `PROVIDERS` in [`shared/events.ts`](src/shared/events.ts) and to the registry in [`providers/index.ts`](src/server/providers/index.ts). Because `stream()` yields only `AppEvent`, the frontend needs no changes — it cannot tell the vendors apart.

Discovery is shared: [`discovery.ts`](src/server/providers/discovery.ts) takes a `CliSpec` (binary name, npm package, path to the real entry point) and returns a spawnable **argv** rather than a bare path.

## Build

```bash
bun run build        # host platform  -> ./bunview[.exe]
bun run build:all    # five targets   -> dist/
```

- The Windows binary stays on the **CONSOLE** subsystem and hides its own console window at
  runtime (`hideOwnConsoleWindow()` in [main.ts](main.ts)).
- The Windows binary also carries an icon, version, publisher, description and copyright in its
  VERSIONINFO resource. The _running window_ gets its icon separately, from `setWindowIcon()` in
  [main.ts](main.ts) — Windows treats the file icon and the window icon as unrelated.
- macOS gets a `.app` bundle with a `.icns` and an ad-hoc signature. Distributing to other Macs
  still needs a Developer ID and notarization.
- Linux gets a `.desktop` file plus the `.png` its `Icon=` points at. Both that path and `Exec=`
  are absolute paths on the _build_ machine, so they need rewriting if the zip is unpacked
  elsewhere.
- All three icons come from the one committed `assets/icon.ico`:
  [build-icons.ts](build-icons.ts) decodes its DIB entries and re-encodes them as PNG and ICNS,
  so there is a single artefact to keep in step with `assets/icon.svg`.
- Tailwind runs **before** the bundler: `generated.css` is an _input_ (the HTML links it).

The compiled binary spawns the _system_ `claude`, resolved at runtime.

### How to bundle agent deps instead

To ship an app that needs no separate CLI install, bundle the platform binary instead:

```ts
import binPath from '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' with { type: 'file' }
import { extractFromBunfs } from '@anthropic-ai/claude-agent-sdk/extract'
// pathToClaudeCodeExecutable: extractFromBunfs(binPath)
```

`require.resolve` cannot see into the compiled `$bunfs`, which is what `extractFromBunfs` (SDK ≥ 0.3.144) exists for. Not used here because cross-compiling five targets would require all eight per-platform packages present.

## Frontend fallback

The frontend is bundled by Bun's HTML entrypoint, imported inside the Worker. If a future Bun release breaks that under `--compile`, pre-bundle in `build.ts` and serve the output through `with { type: 'file' }` imports (that is what `declarations.d.ts` is for). This loses HMR, so it is a deliberate edit rather than a runtime switch.:

```ts
await Bun.build({
  entrypoints: ['./src/client/index.html'],
  outdir: './dist/client',
  naming: { entry: '[name].[ext]', asset: '[name].[ext]' }, // no hashes: specifiers must be writable
  splitting: false, // no unnamed shared chunk
  minify: true,
})
```
