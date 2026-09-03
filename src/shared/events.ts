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
 *
 * Takes the provider because three of these name a product and one names a command. As a flat
 * record they were hardcoded Claude prose that the Codex provider yielded verbatim, so a user
 * signed out of ChatGPT was told to run `claude auth login`.
 */
export function errorCopy(code: AppErrorCode, provider: ProviderId): string {
  const { label } = PROVIDERS[provider]
  switch (code) {
    case 'cli_missing':
      return `${label} isn’t installed, or BunView can’t find it.`
    case 'not_authenticated':
      return `${label} isn’t signed in. Run \`${loginCommand(provider)}\` in a terminal.`
    case 'cli_failed':
      return `${label} couldn’t finish that request. Check the app log and try again.`
    case 'aborted':
      return 'Stopped.'
    case 'timeout':
      return 'That took too long and was stopped.'
    case 'bad_request':
      return 'That message couldn’t be sent.'
  }
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
  /**
   * The sign-in subcommand, minus the binary name.
   *
   * Minus the binary name because the binary this app found is very often NOT the bare one: a
   * managed install lives in the app's data directory, deliberately off PATH, so handing
   * `codex login` to a terminal produces "'codex' is not recognized". What gets spawned is the
   * DISCOVERED argv plus these. `loginCommand()` rebuilds the readable form for prose, and is
   * derived rather than stored so the two cannot drift.
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
    loginArgs: ['login'],
    appTools: false,
    // Stated in the picker rather than discovered later. Note what this does NOT say: Codex's
    // OWN tools — shell, file edits, web search, any MCP server the user has configured — work
    // fine and show up as tool chips. What is missing is BunView's own tools; see codex.ts.
    caveat: '', // Replies arrive by message instead of token.
  },
}

/**
 * The sign-in command as a human would type it, for prose only.
 *
 * DERIVED, never stored. As a second field beside `loginArgs` nothing kept the two in step,
 * and the drift is invisible: a vendor renaming its subcommand leaves the app spawning one
 * thing and advising another. The binary name is the provider id for both vendors, which is
 * also exactly `CliSpec.binary` in the server's discovery.
 *
 * NOT what gets spawned — see `loginArgs`.
 */
export const loginCommand = (id: ProviderId): string => [id, ...PROVIDERS[id].loginArgs].join(' ')

export const DEFAULT_PROVIDER: ProviderId = 'claude'

export interface ChatRequest {
  provider: ProviderId
  prompt: string
  sessionId: string | null
  model: ModelChoice
  effort: EffortChoice
}

/**
 * Carried by every auth shape, not only the signed-in one.
 *
 * True when the environment holds a variable that would point the CLI at metered API billing
 * instead of the user's plan — `ANTHROPIC_API_KEY` and the Bedrock/Vertex switches.
 *
 * This app strips those from every CLI it spawns, so nothing it runs is ever billed to a key.
 * The sign-in TERMINAL is the one exception, and unavoidably so: it is the user's own login
 * shell, which re-reads their profile after we hand it the command. A login started there can
 * therefore no-op as "already authenticated" against the key while this app, reading status
 * with the key stripped, still reports signed-out — a Retry loop with no visible cause.
 *
 * Telling the user is the only fix that does not involve dictating their shell environment.
 */
interface EnvOverride {
  apiKeyOverride: boolean
}

/** Shape of `GET /api/auth`. Mirrors the provider's auth report, narrowed for the browser. */
export type AuthResponse = EnvOverride &
  (
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
  )

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
