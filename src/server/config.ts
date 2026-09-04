/**
 * Every knob in one place.
 *
 * A scaffold gets copied, and the copy inherits whatever defaults were left here — so the
 * defaults are chosen to be the *safe* end of each axis, and widening any of them is a
 * single deliberate edit rather than a change spread across five call sites.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const str = (key: string): string | undefined => {
  const v = process.env[key]
  return v && v.length > 0 ? v : undefined
}

const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** A directory that is actually there, or undefined — noisily, since the user asked for it. */
const existingDir = (dir: string | undefined): string | undefined => {
  if (!dir) return undefined
  if (existsSync(dir)) return dir
  console.warn(
    `✗ BUNVIEW_CWD is not a directory that exists: ${dir}\n  Falling back to the home directory.`,
  )
  return undefined
}

const bool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key]
  if (v === undefined) return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

/**
 * A comma-separated list, where SET-BUT-EMPTY is a value and not an absence.
 *
 * Deliberately not built on `str`, which folds `''` into `undefined`. That folding is right
 * for a path or a model name — an empty string is not one — but it is wrong for a list whose
 * empty case is the meaningful one: `BUNVIEW_TOOLS=` is how the README says to disable every
 * built-in tool, and through `str` it fell back to the default allowlist instead. A fence
 * documented as closable that no value of the variable could actually close.
 *
 * Exported for `config.test.ts`. `config` itself is computed once at import from whatever the
 * environment held then, so the distinction this draws cannot be exercised through it.
 */
export const list = (key: string, fallback: string): string[] =>
  (process.env[key] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * One value out of a fixed set, warning rather than silently falling back.
 *
 * Exported for `config.test.ts` for the same reason as `list`: `config` is computed once at
 * import from whatever the environment held then, so the rejection path cannot be reached
 * through it.
 */
export const choice = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  const v = str(key)
  if (v === undefined) return fallback
  if ((allowed as readonly string[]).includes(v)) return v as T
  console.warn(`✗ ${key} is not one of ${allowed.join(', ')}: ${v}\n  Using '${fallback}'.`)
  return fallback
}

/** `sandbox_mode`'s documented set, in Codex's own order of increasing reach. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxMode = (typeof SANDBOX_MODES)[number]

/**
 * Which of the user's own settings files to load.
 *
 * Empty by default, and that is load-bearing rather than tidy. With the default (all
 * sources) the spawned session inherits everything in the user's `~/.claude.json` and
 * settings — their CLAUDE.md, skills, hooks, and every MCP server they have configured.
 * On a typical developer machine that can mean Gmail, Drive and Calendar connectors. A chat
 * scaffold silently holding those is exactly the surprise this closes.
 *
 * Set BUNVIEW_SETTING_SOURCES=user,project,local to opt in — an app that WANTS the user's
 * existing tool surface (which is a genuinely good reason) turns it on knowingly.
 */
const settingSources = (str('BUNVIEW_SETTING_SOURCES') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(
    (s): s is 'user' | 'project' | 'local' => s === 'user' || s === 'project' || s === 'local',
  )

/**
 * Where the credential mode starts.
 *
 * `subscription`, because that is the premise of the app. A developer with `ANTHROPIC_API_KEY`
 * exported for unrelated work should not find out afterwards that a scaffold advertising "runs
 * on your plan" spent their card instead.
 *
 * The reason this can be a default at all — rather than the silent strip it used to be — is
 * that the strip is now bounded in two places. Anthropic's terms for running Claude Code
 * inside another product forbid the host removing, disabling or RESTRICTING an authentication
 * method built into the binary, and both bounds exist to keep this on the right side of that:
 *
 *   * The header offers the switch in one click whenever a key is actually present, so the
 *     key path is reachable rather than merely documented.
 *   * `authStatus` in providers/claude.ts refuses to let the strip take someone's LAST
 *     credential — it drops back to `auto` for a user whose only credential is that key,
 *     instead of reporting them signed-out over a login the app itself hid.
 *
 * Take either of those away and this default becomes the thing the terms name.
 *
 * `BUNVIEW_ALLOW_API_KEY` is the variable this replaced. It is still honoured, in the one
 * direction that now means something: `=1` asked for the key to be left alone, which is
 * `auto`. `=0` asked for the strip, which is what happens anyway.
 */
function credentialModeSeed(): 'auto' | 'subscription' {
  const explicit = str('BUNVIEW_CREDENTIAL_MODE')
  if (explicit === 'auto' || explicit === 'subscription') return explicit

  if (explicit) {
    console.warn(
      `✗ BUNVIEW_CREDENTIAL_MODE is not a mode: ${explicit}\n  Expected 'auto' or 'subscription'. Using 'subscription'.`,
    )
  }

  if (process.env.BUNVIEW_ALLOW_API_KEY !== undefined && bool('BUNVIEW_ALLOW_API_KEY', false)) {
    console.warn(
      '! BUNVIEW_ALLOW_API_KEY is deprecated. Using BUNVIEW_CREDENTIAL_MODE=auto, which is\n' +
        '  the same behaviour. The default is now `subscription`, and the app offers the\n' +
        '  switch in its header rather than deciding once at startup.',
    )
    return 'auto'
  }

  return 'subscription'
}

/**
 * `dontAsk`, not `default`.
 *
 * `default` prompts for anything not pre-approved — and this app has nowhere to show a
 * prompt. A headless session that stops to ask a question nobody can answer is a hang, not a
 * safety feature. `dontAsk` denies instead, which is the same decision made immediately and
 * visibly. Anything the app genuinely needs is named in `allowedTools` below.
 */
const permissionMode = str('BUNVIEW_PERMISSION_MODE') ?? 'dontAsk'

if (permissionMode === 'bypassPermissions' && !bool('BUNVIEW_ALLOW_BYPASS', false)) {
  // Refuse rather than warn. `bypassPermissions` disables every permission check, and a
  // scaffold that quietly honours it hands the footgun to whoever forks this next. This is
  // now the ONLY thing standing in its way — an earlier version also passed `--restricted`,
  // which the CLI turned out not to have (see claude-options.ts) — so it fails loudly here.
  console.error(
    '✗ BUNVIEW_PERMISSION_MODE=bypassPermissions requires BUNVIEW_ALLOW_BYPASS=1.\n' +
      '  This disables all permission checks. Set both only if you mean it.',
  )
  process.exit(1)
}

export const config = {
  /** Explicit paths to the agent binaries, skipping discovery entirely. */
  claudePath: str('BUNVIEW_CLAUDE_PATH'),
  codexPath: str('BUNVIEW_CODEX_PATH'),

  /**
   * Whether the app may install a missing CLI for the user.
   *
   * On by default because the install is always gated behind an explicit click that shows the
   * exact command first — but a managed or offline deployment can turn the button off
   * entirely rather than relying on nobody pressing it.
   */
  allowInstall: bool('BUNVIEW_ALLOW_INSTALL', true),

  /**
   * Working directory for the agent session.
   *
   * homedir(), not process.cwd(): a compiled binary launched from a Desktop shortcut gets
   * the Desktop as cwd, and from some shell contexts it gets System32. cwd decides which
   * project bucket the session's transcript lands in AND the only directory the file tools
   * can reach, so it needs to be somewhere stable and user-owned.
   *
   * Checked for existence rather than trusted: this value is handed to `Bun.spawn`, which
   * throws on a working directory that is not there. A stale BUNVIEW_CWD (a typo, an unmounted
   * drive) would otherwise take out the sign-in flow — the one path a user reaches for when
   * something is already wrong.
   */
  cwd: existingDir(str('BUNVIEW_CWD')) ?? homedir(),

  /** Default model when the request does not name one. Undefined = the CLI's own default. */
  model: str('BUNVIEW_MODEL'),

  /**
   * The sandbox Codex runs its OWN shell commands under.
   *
   * A knob rather than the literal it used to be, because the safe end of this axis is not
   * reachable on every platform and a hardcoded value gave the user no way past that.
   *
   * WHAT GOES WRONG ON WINDOWS. Codex has no in-process file tools the way Claude Code does —
   * every read it performs is a shell command, and on Windows that shell is PowerShell
   * (`pwsh.exe`, then `powershell.exe`, both resolved off PATH). Under a sandbox mode other
   * than `danger-full-access` that command has to run inside Codex's sandbox, and on Windows
   * that sandbox is still behind a vendor feature flag — `experimental_windows_sandbox`, with
   * its own `codex-windows-sandbox-setup.exe` helper shipped alongside the binary. So the
   * command does not run, and the model reports the failure in the two shapes it can see from
   * the inside: that PowerShell must not be installed, and that "the environment's file system
   * policy" blocked it.
   *
   * This is why the same machine can list a directory through the Claude provider and not
   * through this one. Nothing about the machine differs; `tools: Read,Grep,Glob` needs no
   * shell, and a sandboxed shell command needs one.
   *
   * `read-only` remains the DEFAULT, on the same principle as everything else in this file:
   * widening is one deliberate edit, not a quiet accommodation. A Windows user who wants
   * Codex's shell to work sets `BUNVIEW_CODEX_SANDBOX=danger-full-access` and knows what they
   * bought — the name is the vendor's, and it is accurate.
   */
  codexSandbox: choice('BUNVIEW_CODEX_SANDBOX', SANDBOX_MODES, 'read-only'),

  /**
   * Whether to turn on Codex's Windows sandbox backend. ON by default, on Windows only.
   *
   * This is the flag that makes the paragraph above a footnote rather than a wall. Codex's
   * Windows sandbox is still behind a vendor feature flag in 0.153, and WITHOUT it there is no
   * mechanism to run a sandboxed command inside — so rather than run the command unsandboxed,
   * Codex does not run it at all. That is the whole bug: on the same machine, through the same
   * app, Claude reads a file and Codex reports that PowerShell must not be installed.
   *
   * Verified against codex-cli 0.153.0 via `codex debug prompt-input`, which renders the
   * model-visible permission profile without needing auth: with `sandbox_mode="workspace-write"`
   * and this flag OFF, the profile degrades silently to the same read-only shape as
   * `sandbox_mode="read-only"`. With it ON, real `access="write"` entries appear. The flag is
   * what supplies enforcement; the mode only says what to enforce.
   *
   * WHAT THIS DOES NOT FENCE, because the profile handed to the model overstates it. There are
   * three backends — `disabled`, `restricted-token` and `elevated` — and the binary is explicit
   * that "Restricted read-only access requires the elevated Windows sandbox backend". The
   * default `restricted-token` backend constrains WRITES via capability SIDs and does not
   * confine reads, yet the `<permission_profile>` in the prompt claims `access="read"` on the
   * workspace root either way. So under the default backend that read scope is guidance to the
   * model, not a boundary. Sandboxing Codex's reads on Windows needs the elevated backend and
   * its one-time privileged setup step (`codex-windows-sandbox-setup.exe`), which this app does
   * not drive.
   *
   * On by default anyway, because the alternative route to a working Codex is
   * `BUNVIEW_CODEX_SANDBOX=danger-full-access`, which turns the sandbox off entirely and drops
   * the write fence too. This keeps the strictly better half. Set `0` to opt out and get the
   * old behaviour back.
   */
  codexWindowsSandbox: bool('BUNVIEW_CODEX_WINDOWS_SANDBOX', process.platform === 'win32'),

  /**
   * The base set of built-in tools that EXIST for this session. The real fence.
   *
   * This replaced a `disallowedTools` denylist, and the difference is the whole point. The
   * SDK's own doc comment on `allowedTools` says it outright: "List of tool names that are
   * auto-allowed without prompting for permission. **To restrict which tools are available,
   * use the `tools` option instead.**" A denylist has to name every dangerous tool, which
   * means a tool added by a future CLI release is permitted by default — the failure mode
   * being that you find out from a changelog. An allowlist inverts that: anything not named
   * here does not exist, forever, without maintenance.
   *
   * `[]` disables every built-in tool, which is the right value for an app whose agent should
   * only ever touch app state through its own MCP tools. This scaffold keeps the three
   * read-only ones so the example prompts have something to demonstrate. `BUNVIEW_TOOLS=` —
   * set, empty — is how you get there, which is why this reads the variable through `list`
   * rather than `str`: `str` treats empty as unset, so the one value that closes the fence
   * silently reopened it to the default.
   *
   * Note this governs BUILT-IN tools only. The app's own `mcp__bunview__*` tools arrive via
   * `mcpServers` and are unaffected — emptying this list does not disarm them.
   */
  tools: list('BUNVIEW_TOOLS', 'Read,Grep,Glob'),

  /**
   * Pre-approved, so no permission prompt can arise in a headless session that has no terminal
   * to show one on. NOT a restriction — see `tools` above, which is.
   *
   * The app's own MCP tools are here because they are ours and only touch app state.
   */
  allowedTools: list('BUNVIEW_ALLOWED_TOOLS', 'Read,Grep,Glob,mcp__bunview__*'),

  permissionMode,
  settingSources,

  /**
   * Seed for the credential mode; the live value lives in `credentials.ts` because the user
   * can change it from the header while the app is running.
   *
   * `subscription` — strip the overrides so the plan is billed. The default; see
   * `credentialModeSeed` above for why that is allowed to be a default and what bounds it.
   *
   * `auto` — hand the CLI the environment as the user actually has it and let the vendor's own
   * precedence pick, which prefers a key when one is present. "Claude Code as published."
   * Reachable in one click from the header whenever a key is actually there, which is the only
   * time the choice is real.
   */
  credentialMode: credentialModeSeed(),

  /** Extra text appended to the system prompt, for apps that need to steer the agent. */
  appendSystemPrompt: str('BUNVIEW_SYSTEM_PROMPT'),

  /**
   * Cap on SILENCE, reset by every message from the agent.
   *
   * A better guard than a wall clock for a long, chatty turn: it catches a wedged process in
   * two minutes without having to predict how long a healthy answer should take, and a
   * healthy turn is never silent for two minutes once it has started.
   */
  stallTimeoutMs: num('BUNVIEW_STALL_MS', 120_000),

  /** Backstop against an agentic loop running for an hour on the user's plan. */
  wallTimeoutMs: num('BUNVIEW_WALL_MS', 600_000),

  /** 0 = let the OS choose. The ready handshake carries the real port back to the window. */
  port: Number(process.env.BUNVIEW_PORT) || 0,
} as const
