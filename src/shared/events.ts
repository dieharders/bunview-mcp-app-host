/**
 * The wire contract between the server and the browser. Imported by both sides.
 *
 * This union is CLOSED on purpose. The obvious shortcut — forward the agent's own JSON
 * straight through and let the UI pick it apart — is wrong for four independent reasons,
 * any one of which is sufficient:
 *
 *  1. It is not our contract. The agent's stream format is an unversioned internal wire
 *     format that gains message types every release. Forward it and every `claude` update
 *     becomes a candidate frontend break, in a parser we neither own nor can pin.
 *
 *  2. It is the provider seam. Swapping in a Codex or Gemini CLI is a one-file change ONLY
 *     if the browser has never seen a Claude-shaped event. Otherwise `Provider` is
 *     decorative and the UI is quietly Claude-specific.
 *
 *  3. It is a disclosure boundary. Raw agent events carry absolute filesystem paths, the
 *     echoed system prompt, and — in `input_json_delta` — tool INPUTS, which for an Edit or
 *     Write are file contents. Note that `tool` below carries a name and nothing else.
 *
 *  4. Volume. With partial messages enabled the agent emits a full envelope per token,
 *     each repeating the session id and a fresh uuid: roughly 5x the bytes for the same
 *     text, all re-parsed on the browser's main thread at ~50 events a second.
 */

export type AppEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'delta'; text: string }
  | { type: 'thinking' }
  /** A tool call started. NAME ONLY — never the input. See reason 3 above. */
  | { type: 'tool'; name: string }
  /** App state changed, because an in-process MCP tool mutated it. */
  | { type: 'state'; status: string | null; notes: string[] }
  | { type: 'done'; sessionId: string | null; durationMs: number | null }
  | { type: 'error'; code: AppErrorCode; message: string }

export type AppErrorCode =
  'cli_missing' | 'not_authenticated' | 'cli_failed' | 'aborted' | 'timeout' | 'bad_request'

/**
 * Client-owned copy for every failure mode.
 *
 * The agent's own error prose NEVER reaches the DOM: it is written for a terminal, mentions
 * paths and flags that mean nothing here, and is not a string we control the stability of.
 * The cause goes to the server log; one of these goes to the user.
 */
export const ERROR_COPY: Record<AppErrorCode, string> = {
  cli_missing: 'Claude Code isn’t installed, or BunView can’t find it.',
  not_authenticated: 'Claude Code isn’t signed in. Run `claude auth login` in a terminal.',
  cli_failed: 'Claude Code couldn’t finish that request. Check the app log and try again.',
  aborted: 'Stopped.',
  timeout: 'That took too long and was stopped.',
  bad_request: 'That message couldn’t be sent.',
}

/** Model choices offered in the composer. Aliases resolve to the latest of each family. */
export const MODELS = ['default', 'opus', 'sonnet', 'haiku', 'fable'] as const
export type ModelChoice = (typeof MODELS)[number]

/**
 * Effort levels. Session-scoped: passing one here overrides the user's configured effort for
 * this request only and never writes to their config.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortChoice = (typeof EFFORTS)[number]

/** Cheap and fast. A scaffold should not burn a Max plan's quota to say hello. */
export const DEFAULT_EFFORT: EffortChoice = 'low'
export const DEFAULT_MODEL: ModelChoice = 'default'

/**
 * Which vendor's agent to talk to.
 *
 * The user picks this BEFORE the app probes anything, because probing means spawning that
 * vendor's CLI to read their account — work nobody should do on a subscription the user has
 * not said they want to use.
 */
export const PROVIDER_IDS = ['claude', 'codex'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface ProviderInfo {
  id: ProviderId
  /** Product name, as its vendor writes it. */
  label: string
  /** The subscription this runs on, for the picker. */
  plan: string
  /** Who publishes it, named in the install prompt so consent knows whose binary it is. */
  vendor: string
  /** npm package that provides the CLI. Kept for discovery's path layout, not for installing. */
  npmPackage: string
  /** Command the user would type to sign in. DISPLAY ONLY — see `loginArgs`. */
  loginCommand: string
  /**
   * The sign-in subcommand, minus the binary name.
   *
   * Split out because the binary this app found is very often NOT the bare name in
   * `loginCommand`: a managed install lives in the app's data directory, deliberately off
   * PATH, so handing `codex login` to a terminal produces "'codex' is not recognized". The
   * terminal gets the discovered argv plus these; the user gets the readable string above.
   */
  loginArgs: string[]
  /**
   * Whether this app's OWN tools reach the agent. False means the starter prompts that
   * demonstrate them are hidden, because suggesting a tool the agent cannot call is worse
   * than suggesting nothing. See `src/server/providers/codex.ts` for why Codex is false.
   */
  appTools: boolean
  /** Honest note about what this provider cannot do here. Empty when nothing is missing. */
  caveat: string
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    plan: 'Claude Pro or Max',
    npmPackage: '@anthropic-ai/claude-code',
    loginCommand: 'claude auth login',
    loginArgs: ['auth', 'login'],
    appTools: true,
    caveat: '',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    plan: 'ChatGPT Plus, Pro or Business',
    npmPackage: '@openai/codex',
    loginCommand: 'codex login',
    loginArgs: ['login'],
    appTools: false,
    // Stated in the picker rather than discovered later. Note what this does NOT say: Codex's
    // OWN tools — shell, file edits, web search, any MCP server the user has configured — work
    // fine and show up as tool chips. What is missing is BunView's own tools; see codex.ts.
    caveat: '', // Replies arrive by message instead of token.
  },
}

export const DEFAULT_PROVIDER: ProviderId = 'claude'

export interface ChatRequest {
  provider: ProviderId
  prompt: string
  sessionId: string | null
  model: ModelChoice
  effort: EffortChoice
}

/** Shape of `GET /api/auth`. Mirrors the provider's auth report, narrowed for the browser. */
export type AuthResponse =
  | { state: 'ok'; account: string | null; plan: string | null; subscription: boolean }
  | { state: 'logged_out' }
  | {
      state: 'cli_missing'
      searched: string[]
      unresolvedShim: string | null
      /** Whether to offer an Install button. Decided on the server, whose preconditions
       *  (and BUNVIEW_ALLOW_INSTALL) the browser cannot see. */
      canInstall: boolean
    }
  | { state: 'unknown' }

/**
 * Progress from a setup action that changes the user's machine (installing a CLI) or opens an
 * external flow (signing in). Separate from AppEvent because these are not conversation.
 */
export type SetupEvent =
  { type: 'log'; line: string } | { type: 'done'; ok: boolean; message: string }

export interface AppState {
  status: string | null
  notes: string[]
}
