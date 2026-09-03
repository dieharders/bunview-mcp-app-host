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
 * `BUNVIEW_ALLOW_API_KEY` is the variable this replaced. It is still honoured — but only in
 * the one direction that means something now. Someone who set it to `0` asked for the strip,
 * and silently ignoring a safety setting because it was renamed is precisely the "wrong
 * override, quietly" failure this project refuses elsewhere. `=1` needs no handling: it asked
 * for the behaviour that is now the default.
 */
function credentialModeSeed(): 'auto' | 'subscription' {
  const explicit = str('BUNVIEW_CREDENTIAL_MODE')
  if (explicit === 'auto' || explicit === 'subscription') return explicit

  if (explicit) {
    console.warn(
      `✗ BUNVIEW_CREDENTIAL_MODE is not a mode: ${explicit}\n  Expected 'auto' or 'subscription'. Using 'auto'.`,
    )
  }

  const legacy = process.env.BUNVIEW_ALLOW_API_KEY
  if (legacy !== undefined && !bool('BUNVIEW_ALLOW_API_KEY', true)) {
    console.warn(
      '! BUNVIEW_ALLOW_API_KEY is deprecated. Using BUNVIEW_CREDENTIAL_MODE=subscription,\n' +
        '  which is the same behaviour. The default is now `auto`, and the app offers the\n' +
        '  switch in its header instead of deciding for the user.',
    )
    return 'subscription'
  }

  return 'auto'
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
   * read-only ones so the example prompts have something to demonstrate.
   *
   * Note this governs BUILT-IN tools only. The app's own `mcp__bunview__*` tools arrive via
   * `mcpServers` and are unaffected — emptying this list does not disarm them.
   */
  tools: (str('BUNVIEW_TOOLS') ?? 'Read,Grep,Glob')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Pre-approved, so no permission prompt can arise in a headless session that has no terminal
   * to show one on. NOT a restriction — see `tools` above, which is.
   *
   * The app's own MCP tools are here because they are ours and only touch app state.
   */
  allowedTools: (str('BUNVIEW_ALLOWED_TOOLS') ?? 'Read,Grep,Glob,mcp__bunview__*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  permissionMode,
  settingSources,

  /**
   * Seed for the credential mode; the live value lives in `credentials.ts` because the user
   * can change it from the header while the app is running.
   *
   * `auto` — hand the CLI the environment as the user actually has it, and let the vendor's
   * own precedence pick. This is the default because the terms for running Claude Code inside
   * another product forbid the host removing an authentication method built into it, and an
   * unconditional strip of `ANTHROPIC_API_KEY` is exactly that.
   *
   * `subscription` — strip the overrides so the plan is billed. Reachable in one click from
   * the header whenever a key is actually present, which is the only time the choice is real.
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
