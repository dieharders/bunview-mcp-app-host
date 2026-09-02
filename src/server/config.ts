/**
 * Every knob in one place.
 *
 * A scaffold gets copied, and the copy inherits whatever defaults were left here — so the
 * defaults are chosen to be the *safe* end of each axis, and widening any of them is a
 * single deliberate edit rather than a change spread across five call sites.
 */
import { homedir } from 'node:os'

const str = (key: string): string | undefined => {
  const v = process.env[key]
  return v && v.length > 0 ? v : undefined
}

const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : fallback
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

const permissionMode = str('BUNVIEW_PERMISSION_MODE') ?? 'default'

if (permissionMode === 'bypassPermissions' && !bool('BUNVIEW_ALLOW_BYPASS', false)) {
  // Refuse rather than warn. `bypassPermissions` disables every permission check, and a
  // scaffold that quietly honours it hands the footgun to whoever forks this next. The
  // `--restricted` flag we pass would reject it independently, but failing here makes the
  // refusal legible instead of mysterious.
  console.error(
    '✗ BUNVIEW_PERMISSION_MODE=bypassPermissions requires BUNVIEW_ALLOW_BYPASS=1.\n' +
      '  This disables all permission checks. Set both only if you mean it.',
  )
  process.exit(1)
}

export const config = {
  /** Explicit path to the agent binary, skipping discovery entirely. */
  claudePath: str('BUNVIEW_CLAUDE_PATH'),

  /**
   * Working directory for the agent session.
   *
   * homedir(), not process.cwd(): a compiled binary launched from a Desktop shortcut gets
   * the Desktop as cwd, and from some shell contexts it gets System32. cwd decides which
   * project bucket the session's transcript lands in AND which directory `--restricted`
   * confines the file tools to, so it needs to be somewhere stable and user-owned.
   */
  cwd: str('BUNVIEW_CWD') ?? homedir(),

  /** Default model when the request does not name one. Undefined = the CLI's own default. */
  model: str('BUNVIEW_MODEL'),

  /**
   * Read-only by default.
   *
   * `allowedTools` pre-approves, so no permission prompt can arise in a headless session
   * that has no terminal to show one on. `disallowedTools` is the actual fence. The app's
   * own MCP tools are pre-approved because they are ours and they only touch app state.
   */
  allowedTools: (str('BUNVIEW_ALLOWED_TOOLS') ?? 'Read,Grep,Glob,mcp__bunview__*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  disallowedTools: (
    str('BUNVIEW_DISALLOWED_TOOLS') ?? 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  permissionMode,
  settingSources,

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
