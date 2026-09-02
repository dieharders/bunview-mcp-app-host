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
bun run dev
```

A window opens and asks which plan to connect — Claude Code or Codex. **Nothing is contacted
until you choose**, because probing a vendor means spawning their CLI to read your account.

From there the app walks you the rest of the way: if the CLI is missing it offers to install
it — downloading the vendor's own signed binary and verifying its checksum, no npm or Node
required — and if it is installed but signed out it offers a Sign in button. Once the header badge shows your plan, the composer unlocks.

The right-hand panel shows app state the agent can write to through this app's own MCP tools.
Try: **“Set the app status to hello and add a note.”** The panel updates as it answers.

## Providers

|                 | Claude Code                 | Codex                         |
| --------------- | --------------------------- | ----------------------------- |
| Runs on         | Claude Pro / Max            | ChatGPT Plus / Pro / Business |
| Package         | `@anthropic-ai/claude-code` | `@openai/codex`               |
| Streaming       | token by token              | **per message**               |
| App's MCP tools | yes, in-process             | **no**                        |

Both differences are stated on the picker rather than discovered later.

To be precise about the second row: **Codex's own tools work fine** — shell, file edits, web
search, and any MCP server you have configured are all mapped to tool chips. What is missing
is _BunView's_ tools, and the reason is the registration channel rather than the tools. The
Claude Agent SDK has a bidirectional control protocol over the same stdio stream it uses to
drive the CLI, so `createSdkMcpServer` registers a tool **for one session only** and the
handler runs in this process. `codex exec --json` is one-way — prompt in, JSONL out — with no
channel to answer on.

It is still doable: Codex reads MCP servers from `~/.codex/config.toml`, and a `url` entry
there uses streamable HTTP, so BunView could serve `POST /mcp` from the Bun server it already
runs and keep the tools in-process after all. The costs are what stopped it — it writes to the
user's **global** config rather than being scoped to a session, it currently needs
`experimental_use_rmcp_client = true`, and it means implementing the MCP wire protocol rather
than calling a helper.

> The Codex provider is written against OpenAI's published CLI reference and has **not** been
> exercised against a real `codex` install. Its event mapping is deliberately tolerant, so an
> unverified field name degrades to "no event" rather than a crash — but treat it as untested.

## Dev's Notes

Goal:
I want to build a minimal scaffold project that will serve as a starting point for my future MCP apps. This project is a native app that can be installed on desktop (Windows, MacOS, Linux, maybe mobile too?). It's main responsibility is to provide a mechanism to interface with a user's subscription AI plan.

Requirements:

- Use Bun.js for the server component
- WebView for the frontend UI. Make a very simple UI for now just to show the AI response for now.
- Integrate with the subscription based AI (not api, start with Claude for now). I believe we need to spawn a `claude cli` process to accomplish this?
- A simple example of streaming response from AI agent

## Prerequisites

|             |                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Bun         | ≥ 1.3.9 (`--watch=always` is used in dev)                                                                                        |
| Claude Code | none — the app can install it. Or `curl -fsSL https://claude.ai/install.sh \| bash` / `irm https://claude.ai/install.ps1 \| iex` |
| Windows     | WebView2 runtime — preinstalled on Windows 11 and current Windows 10                                                             |
| macOS       | Nothing; WKWebView is built in                                                                                                   |
| Linux       | GTK 4 + WebKitGTK 6 — `apt install libgtk-4-1 libwebkitgtk-6.0-4` / `pacman -S gtk4 webkitgtk-6.0`                               |

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

`GET /api/auth?provider=<id>` shells the vendor's status command (`claude auth status --json`,
`codex login status`) and reports which credential is actually in
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
rendering — no IPC, no serialization boundary, no protocol to design, and nothing written to
the user's global config. A stdio MCP server would instead put a process boundary between the
agent's tools and your app's state; an HTTP one keeps them together but means implementing the
wire protocol and registering it globally.

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
| `BUNVIEW_CLAUDE_PATH`                  | _(discovered)_                                    | Explicit path to the Claude binary                                 |
| `BUNVIEW_CODEX_PATH`                   | _(discovered)_                                    | Explicit path to the Codex binary                                  |
| `BUNVIEW_ALLOW_INSTALL`                | `1`                                               | Offer to install a missing CLI. Set `0` for managed/offline builds |
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

## Onboarding: install and sign in

Two endpoints reach outside the app's own process, and both are gated behind an explicit click
that shows what will run first:

- **`POST /api/install`** downloads the vendor's own signed binary into BunView's data folder
  and verifies its SHA-256, streaming progress back as SSE. Afterwards it clears the discovery
  cache and re-detects, so the new binary is found without a restart.
  `BUNVIEW_ALLOW_INSTALL=0` removes the button entirely.

  **Why not `npm install -g`**, which this replaced — three independent reasons:

  1. **Anthropic deprecated it.** Their README says so outright: _"Installation via npm is
     deprecated. Use one of the recommended methods below."_ It is also the only listed method
     that needs Node at all.
  2. **It cannot work from a GUI app on Windows.** A process's environment block is fixed at
     launch and [cannot be changed from outside](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables),
     so after `npm -g` adds a directory to PATH, this app and every child it spawns still see
     the old PATH. "Installed successfully, but I can't find it — please restart" is the
     _expected_ outcome there, not an edge case.
  3. **It has the whole documented failure surface**: EACCES on global prefixes, the
     wrong-prefix bug when several Node versions exist, corporate registries that mirror the
     wrapper package but not the eight platform packages, and `.cmd` shims that Node refuses
     to spawn since CVE-2024-27980.

  What [`install/`](src/server/install/) does instead is what the vendors' own `install.sh` /
  `install.ps1` do — read the release manifest, download the platform binary, verify the
  checksum — minus the shell. No npm, no Node, no shell, no admin rights. The binaries arrive
  Developer ID-signed and Apple-notarized (they are the vendor's, unmodified), and a file
  fetched programmatically carries no `com.apple.quarantine`, so Gatekeeper does not gate it.
  BunView adds no signing obligations of its own.

  It installs to the app's data folder and **not** onto PATH — `%LOCALAPPDATA%\BunView`,
  `~/Library/Application Support/BunView`, or `$XDG_DATA_HOME/BunView`. Discovery checks it
  **last**, so a `claude` the user installed themselves stays authoritative; these tools share
  state under `~/.claude` / `~/.codex`, and quietly preferring our copy over one they already
  configured is how a working setup starts behaving oddly. Uninstalling is deleting the folder.

  Nothing auto-installs. Cursor shipped a silent auto-install of its agent in 1.6.26 and
  reverted it in 1.7 after user pushback.

- **`POST /api/login`** opens the vendor's sign-in command **in a real terminal window** rather
  than driving it headless through pipes. Both vendors' login flows are interactive — they open
  a browser, run a localhost callback listener, and may print a code to confirm — and
  reimplementing that means owning a flow we do not control and cannot test against every
  version. Getting it subtly wrong strands the user with no way to sign in at all, so this
  delegates to the vendor's own proven path and then says "finish signing in, then press Retry".

## Adding a provider

Implement [`Provider`](src/server/providers/types.ts) — `detect()`, `authStatus()`, `stream()` —
in a file beside `claude.ts` and `codex.ts`, add it to `PROVIDERS` in
[`shared/events.ts`](src/shared/events.ts) and to the registry in
[`providers/index.ts`](src/server/providers/index.ts). Because `stream()` yields only
`AppEvent`, the frontend needs no changes — it cannot tell the vendors apart.

Discovery is shared: [`discovery.ts`](src/server/providers/discovery.ts) takes a `CliSpec`
(binary name, npm package, path to the real entry point) and returns a spawnable **argv**
rather than a bare path. That last part matters — Claude Code's bin is a native `claude.exe`,
while Codex's is `bin/codex.js`, a Node launcher that has to be run as `node codex.js`.

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
