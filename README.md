# BunView

A minimal desktop scaffold for apps that run on **your Claude subscription** instead of a
metered API key. Bun server, native OS webview, React frontend, one executable.

It is a starting point to fork, not a product. Everything in it is either load-bearing or an
obvious extension point.

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

## Quickstart

```bash
bun install
claude auth login     # once, if you have not already
bun run dev
```

A window opens. The header shows your plan; the right-hand panel shows app state the agent
can write to through this app's own MCP tools.

Try: **“Set the app status to hello and add a note.”** The panel updates as it answers.

## Prerequisites

|             |                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Bun         | ≥ 1.3.9 (`--watch=always` is used in dev)                                                          |
| Claude Code | `npm install -g @anthropic-ai/claude-code`, then `claude auth login`                               |
| Windows     | WebView2 runtime — preinstalled on Windows 11 and current Windows 10                               |
| macOS       | Nothing; WKWebView is built in                                                                     |
| Linux       | GTK 4 + WebKitGTK 6 — `apt install libgtk-4-1 libwebkitgtk-6.0-4` / `pacman -S gtk4 webkitgtk-6.0` |

Desktop only. The whole design spawns a local process, which iOS and Android forbid; a mobile
client would need this server hosted somewhere and a remote auth story instead.

## How the subscription part works

The app never sees a token. `claude auth login` writes OAuth credentials to
`~/.claude/.credentials.json` (or the OS keychain), and the agent binary reads them when the
app spawns it. Usage bills against your Pro/Max quota and obeys its rate limits.

**The footgun this closes:** if `ANTHROPIC_API_KEY` is set in the environment, the CLI prefers
it and bills API credits instead — silently, with no visible symptom until the invoice. So
[`src/server/env.ts`](src/server/env.ts) strips it (and `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, the Bedrock/Vertex switches) from the child environment. Set
`BUNVIEW_ALLOW_API_KEY=1` to opt back in deliberately.

`GET /api/auth` shells `claude auth status --json` and reports which credential is actually in
play, so the badge says _“Claude max · you@example.com”_ on a subscription and warns _“API key
— usage is billed per token”_ when it is not.

## MCP: this app is the host

MCP carries **tools**. It has no concept of a conversation, a model or a subscription, so it
always needs a host that already has a model attached — and here that host is this app. The
app registers its _own_ MCP server into the agent session, so the agent can call tools that
change the app's live state.

[`src/server/mcp/app-tools.ts`](src/server/mcp/app-tools.ts) is the seam:

```ts
export const appToolsServer = createSdkMcpServer({
  name: 'bunview',
  tools: [
    tool('set_status', '…', { text: z.string() }, async ({ text }) => ok(setStatus(text))),
    // …
  ],
})
```

`createSdkMcpServer` runs these **in this process**. The handlers close over
[`src/server/state.ts`](src/server/state.ts), so a tool call mutates the same object the UI is
rendering — no IPC, no serialization boundary, no protocol to design. Pointing `--mcp-config`
at a separate stdio or HTTP server would put a process boundary between the agent's tools and
your app's state and force you to build across it.

**To fork:** delete the three toy tools, register your real domain tools. Nothing else changes.

The other direction — publishing the same tool surface _outward_ so Claude Code can drive your
app from a terminal — is a separate front door onto the same tools. Not built here.

## Safety defaults

Read-only, and arranged so widening scope is a deliberate act.

| Env var                                | Default                                           | Effect                                                             |
| -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `BUNVIEW_ALLOWED_TOOLS`                | `Read,Grep,Glob,mcp__bunview__*`                  | Pre-approved, so no prompt can arise in a headless session         |
| `BUNVIEW_DISALLOWED_TOOLS`             | `Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch` | The actual fence                                                   |
| `BUNVIEW_PERMISSION_MODE`              | `default`                                         | `bypassPermissions` additionally requires `BUNVIEW_ALLOW_BYPASS=1` |
| `BUNVIEW_SETTING_SOURCES`              | _(empty)_                                         | Do not inherit the user's CLAUDE.md, skills, hooks or MCP servers  |
| `BUNVIEW_CWD`                          | `homedir()`                                       | Session bucket, and what `--restricted` confines file tools to     |
| `BUNVIEW_MODEL`                        | _(CLI default)_                                   | Also selectable per-message in the UI                              |
| `BUNVIEW_EFFORT`                       | `low`                                             | Session-scoped; never written to your config                       |
| `BUNVIEW_CLAUDE_PATH`                  | _(discovered)_                                    | Explicit path to the agent binary                                  |
| `BUNVIEW_ALLOW_API_KEY`                | `0`                                               | Stop stripping `ANTHROPIC_API_KEY`                                 |
| `BUNVIEW_STALL_MS` / `BUNVIEW_WALL_MS` | `120000` / `600000`                               | Silence cap / total cap                                            |
| `BUNVIEW_PORT`                         | `0`                                               | `0` = ephemeral                                                    |

Two things are worth knowing about the defaults:

- **`settingSources: []` is not tidiness.** With the default, the session inherits every MCP
  server in the user's `~/.claude.json`. On a working developer machine that can mean Gmail,
  Drive and Calendar. A chat scaffold silently holding those is the surprise this closes.
- **`--restricted` is passed as a hard backstop.** It removes the tools that run commands or
  code, confines file tools to the working directories, ignores user/project/local settings,
  and _refuses `bypassPermissions` outright_ — so an app built on this cannot footgun itself
  by changing one variable.

**Never add `--bare`.** Its own help says auth becomes _“strictly `ANTHROPIC_API_KEY` or
apiKeyHelper … OAuth and keychain are never read”_ — the exact negation of this project.

### Widening scope

An app that needs to read a project directory:

```bash
BUNVIEW_ALLOWED_TOOLS="Read,Grep,Glob,mcp__bunview__*" \
BUNVIEW_CWD="/path/to/project" \
bun run dev
```

`--restricted` then confines those file tools to that directory automatically.

## Architecture notes

**The webview owns the main thread.** `webview.run()` runs a blocking native event loop, so a
`Bun.serve` on the same thread would register with an event loop that never runs again and
every request would hang. The server therefore lives in a Worker, and the two meet once, at
the `{ type: 'ready', port }` handshake.

**`main.ts` must stay at the repo root, and the Worker specifier must stay a string literal.**
Bun discovers worker modules by static analysis of `new Worker('./src/server/worker.ts')` —
wrapping it in `new URL(…, import.meta.url)` silently omits the module from the compiled
binary. And a plain specifier resolves against the bunfs root, which is the common ancestor of
`build.ts`'s `entrypoints`; keeping `main.ts` at the root makes that the repo root so the path
means the same thing in dev and in the executable.

**Events are a closed union.** [`src/shared/events.ts`](src/shared/events.ts) defines every
shape the browser can see, and [`claude-map.ts`](src/server/providers/claude-map.ts) maps the
agent's messages onto it, dropping anything unrecognised. That keeps an unversioned internal
wire format out of the UI, keeps the provider seam real, and — importantly — keeps tool
_inputs_ off the wire, since an `Edit` tool's input is file contents. Tool events carry a name
and nothing else.

**Cancellation has three independent paths**: the client's `AbortController`, the server
listening to both `req.signal` and the stream's `cancel()`, and a process-exit sweep in
[`proc.ts`](src/server/proc.ts). The last one matters because neither `worker.terminate()` nor
`process.exit()` reaps a grandchild — without it, closing the window mid-answer leaves an agent
running against your plan.

**SSE, not `EventSource`.** EventSource cannot POST, cannot set headers, and auto-reconnects
when the server closes the stream — which for a one-shot completion re-fires the whole prompt
the moment the answer finishes.

## Adding a provider

Implement [`Provider`](src/server/providers/types.ts) — `detect()`, `authStatus()`,
`stream()` — in a file beside `claude.ts`, then change the one line in
[`providers/index.ts`](src/server/providers/index.ts). Because `stream()` yields only
`AppEvent`, the frontend needs no changes. It is not a registry on purpose: a `Map` plus a
factory earns its keep only once the UI can actually choose between providers.

## Build

```bash
bun run build        # host platform  -> ./bunview[.exe]
bun run build:all    # five targets   -> dist/
```

- The Windows binary is byte-patched from CONSOLE to GUI subsystem, because Bun's
  `--windows-hide-console` is broken ([oven-sh/bun#19916]) and does not cross-compile.
- macOS gets a `.app` bundle with an ad-hoc signature. Distributing to other Macs still needs a
  Developer ID and notarization.
- Linux gets a `.desktop` file.
- Tailwind runs **before** the bundler: `generated.css` is an _input_ (the HTML links it), so
  `build.ts` fails loudly if it is missing rather than shipping an unstyled binary.

The compiled binary spawns the _system_ `claude`, resolved at runtime. To ship an app that
needs no separate CLI install, bundle the platform binary instead:

```ts
import binPath from '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' with { type: 'file' }
import { extractFromBunfs } from '@anthropic-ai/claude-agent-sdk/extract'
// pathToClaudeCodeExecutable: extractFromBunfs(binPath)
```

`require.resolve` cannot see into the compiled `$bunfs`, which is what `extractFromBunfs` (SDK
≥ 0.3.144) exists for. Not used here because cross-compiling five targets would require all
eight per-platform packages present.

## Frontend fallback

The frontend is bundled by Bun's HTML entrypoint, imported inside the Worker. If a future Bun
release breaks that under `--compile`, pre-bundle in `build.ts`:

```ts
await Bun.build({
  entrypoints: ['./src/client/index.html'],
  outdir: './dist/client',
  naming: { entry: '[name].[ext]', asset: '[name].[ext]' }, // no hashes: specifiers must be writable
  splitting: false, // no unnamed shared chunk
  minify: true,
})
```

and serve the output through `with { type: 'file' }` imports (that is what `declarations.d.ts`
is for). This loses HMR, so it is a deliberate edit rather than a runtime switch.

## Tests

```bash
bun test        # event mapping, binary discovery, UI states
bun run typecheck
```

`bun test` rather than Vitest, to keep one toolchain. The file-level conventions are unchanged,
so switching is mechanical.

## Deliberately left out

Markdown rendering of replies (plain text today — `react-markdown` plus sanitisation is the
first upgrade) · our own conversation persistence (the CLI keeps a transcript, so `resume`
works) · tool-result rendering · thinking prose · an outward MCP server · routing, a state
library, a data-fetching library · multi-window, tray, auto-update, installers · light theme ·
cost display, because `total_cost_usd` is an API-equivalent figure and showing “$0.04” on a
subscription would misrepresent it.

[oven-sh/bun#19916]: https://github.com/oven-sh/bun/issues/19916
