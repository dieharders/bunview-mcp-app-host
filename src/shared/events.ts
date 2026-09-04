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

/**
 * Model and effort are PER PROVIDER, and this used to be one global list.
 *
 * That list held Claude's aliases — `opus`, `sonnet`, `haiku`, `fable` — and the composer
 * showed them whichever provider was selected. Picking one as a Codex user sent
 * `codex --model opus`, which is not a model OpenAI publishes. Effort was worse: the picker
 * offered Claude's five levels and the Codex provider never passed the value at all, so the
 * control did nothing and said nothing about doing nothing.
 *
 * They are plain strings rather than a closed union because both CLIs take a free-form model
 * argument, and the vendors' model line-ups change faster than this file will. The lists in
 * `PROVIDERS` are what the UI offers and what the server validates against; anything not on
 * the chosen provider's list falls back to the default rather than reaching a subprocess.
 */
export type ModelChoice = string
export type EffortChoice = string

/** The CLI's own default model. Always offered first, so the app never has to be right about
 *  which model is currently the vendor's flagship. */
export const DEFAULT_MODEL: ModelChoice = 'default'

/**
 * Cheap and fast. A scaffold should not burn a subscription's quota to say hello.
 *
 * Session-scoped: passing one overrides the user's configured effort for this request only and
 * never writes to their config. `low` is on both providers' lists, which is what lets one
 * constant serve both.
 */
export const DEFAULT_EFFORT: EffortChoice = 'low'

/**
 * Which vendor's agent to talk to.
 *
 * The user picks this BEFORE the app probes anything, because probing means spawning that
 * vendor's CLI to read their account — work nobody should do on a subscription the user has
 * not said they want to use.
 */
export const PROVIDER_IDS = ['claude', 'codex'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/**
 * One extra knob a provider accepts, declared rather than hardcoded into the UI.
 *
 * `model` and `effort` stay first-class below because both vendors have them and the server
 * seam already carries them. Everything else lives here so that adding a provider — or a knob
 * to an existing one — is a data change in this file, not a new branch in the composer.
 *
 * Deliberately limited to QUALITY and PRESENTATION. Nothing here may widen what the agent can
 * touch: the sandbox, the tool list and the permission mode are set from the environment on
 * purpose (see `config.ts`), and putting them behind a dropdown would hand every user a
 * control the safety posture assumes nobody has.
 */
export interface ProviderSetting {
  /** Wire key. Also the server's lookup key when mapping to vendor flags. */
  id: string
  label: string
  /** Allowed values, first one being the default. */
  values: readonly string[]
  /** Shown under the control. Keep it to one short line. */
  hint?: string
}

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

  /**
   * Models offered in the composer, `'default'` first.
   *
   * Kept SHORT and headed by the vendor's own default on purpose: these line-ups move — the
   * Codex list below already has entries dated to retire — and a scaffold that hardcodes a
   * flagship goes stale silently. `'default'` means "pass no --model at all", so the vendor's
   * current pick is always reachable without this file being right.
   */
  models: readonly string[]

  /** Reasoning effort levels this vendor accepts. Must include `DEFAULT_EFFORT`. */
  efforts: readonly string[]

  /** Everything else this vendor lets the user set. See ProviderSetting. */
  settings: readonly ProviderSetting[]
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
    // Aliases, not pinned ids: they resolve to the latest of each family, so this list does
    // not go stale every time a point release ships.
    models: ['default', 'opus', 'sonnet', 'haiku', 'fable'],
    // Exactly the SDK's `EffortLevel` union. Widening this without widening that is how a
    // dropdown value becomes a rejected subprocess argument.
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    settings: [
      {
        id: 'thinking',
        label: 'Thinking',
        // `default` FIRST, and therefore the default — see `settingDefault` below, which is
        // why this matters. With `adaptive` in this slot `coerceSettings` filled the setting
        // with it on every turn, so claude-options.ts sent `thinking: {type:'adaptive'}`
        // unconditionally and its "omit and let the CLI decide" branch was unreachable.
        // Adaptive is Opus 4.6+ (`ThinkingAdaptive` in the SDK types says so) and is ALREADY
        // the CLI's own default on models that support it — so omitting gets the good
        // behaviour everywhere, while sending it explicitly aims it at haiku too.
        values: ['default', 'adaptive', 'off'],
        hint: 'Adaptive lets Claude decide how much to reason (Opus 4.6+).',
      },
    ],
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
    // OpenAI's published Codex slugs. `default` first for the reason given on the field: the
    // 5.4 entries are already dated to retire, and the vendor's own default outlives any list
    // written here.
    models: ['default', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    // `model_reasoning_effort`'s documented set. Note it is NOT Claude's: `minimal` exists
    // here and not there, and `max` is the other way round. Sharing one list is what made the
    // composer offer Codex users levels their CLI does not take.
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    settings: [
      {
        id: 'verbosity',
        label: 'Verbosity',
        values: ['medium', 'low', 'high'],
        hint: 'How much prose Codex writes around its answer.',
      },
      {
        id: 'summary',
        label: 'Reasoning',
        values: ['auto', 'concise', 'detailed', 'none'],
        hint: 'How much of its reasoning Codex summarises.',
      },
    ],
  },
}

/**
 * Coerce a submitted value to one this provider actually accepts.
 *
 * Shared by the browser and the server so the fallback is identical in both. The server is the
 * one that matters — a stale client that still holds Claude's model list must not be able to
 * put `opus` on a `codex` command line — but running it client-side too means switching
 * provider re-points the pickers instead of leaving a now-invalid selection showing.
 */
export function coerceChoice(allowed: readonly string[], value: unknown, fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** The default for one declared setting: the first value, by definition of ProviderSetting. */
export const settingDefault = (setting: ProviderSetting): string => setting.values[0] as string

/** Every declared setting at its default, for a provider. */
export function defaultSettings(provider: ProviderId): Record<string, string> {
  const out: Record<string, string> = {}
  for (const setting of PROVIDERS[provider].settings) out[setting.id] = settingDefault(setting)
  return out
}

/** Drop anything the provider did not declare, and coerce what it did. */
export function coerceSettings(provider: ProviderId, raw: unknown): Record<string, string> {
  const submitted = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const setting of PROVIDERS[provider].settings) {
    out[setting.id] = coerceChoice(setting.values, submitted[setting.id], settingDefault(setting))
  }
  return out
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
  /** The provider's declared extra knobs, by `ProviderSetting.id`. */
  settings: Record<string, string>
}

/**
 * How the app treats credentials that would redirect billing away from the user's plan.
 *
 * `auto`         — the CLI gets the environment as it is, and applies its own precedence,
 *                  which prefers an API key when one is present. "Claude Code as published."
 * `subscription` — the app strips those variables from the CLIs it spawns, so the plan is
 *                  billed.
 *
 * The default is `subscription`, because that is this app's premise: a developer who happens
 * to have `ANTHROPIC_API_KEY` exported for unrelated work should not discover afterwards that
 * a scaffold advertising "runs on your plan" was billing their card.
 *
 * That default is bounded by two rules, and both are load-bearing. An app that hosts the
 * vendor's binary may not remove, disable or RESTRICT an authentication method built into it:
 *
 *   1. The strip is never the last word. It is one labelled click away in the header whenever
 *      a key is present, which is the only time the choice is real.
 *   2. The strip never takes the LAST credential. `authStatus` in providers/claude.ts probes
 *      twice and drops back to `auto` for a user whose only credential is the key, rather than
 *      reporting them signed-out over a login the app itself hid.
 */
export const CREDENTIAL_MODES = ['auto', 'subscription'] as const
export type CredentialMode = (typeof CREDENTIAL_MODES)[number]

/**
 * Carried by every auth shape, not only the signed-in one.
 *
 * `apiKeyOverride` is true when the environment holds a variable that COULD point the CLI at
 * metered API billing — `ANTHROPIC_API_KEY` and the Bedrock/Vertex switches. It is the "is
 * there a choice to make" flag, and it is what makes the header's switch appear; whether the
 * key actually won is reported separately, by `subscription` on the `ok` shape, which comes
 * from the CLI rather than from guessing at the vendor's precedence.
 *
 * Reported in every state, because the state it matters most in is `logged_out`: the user is
 * one click from a sign-in that their own shell may quietly redirect. The sign-in TERMINAL is
 * the one thing no mode reaches, and unavoidably so — it is the user's own login shell, which
 * re-reads their profile after we hand it the command. A login started there can therefore
 * no-op as "already authenticated" against the key while this app, in `subscription` mode,
 * still reports signed-out — a Retry loop with no visible cause.
 *
 * Telling the user is the only fix that does not involve dictating their shell environment.
 *
 * `keySource` is the CLI's own name for the credential in play, and it exists because
 * `apiKeyOverride` cannot answer the question on its own. A key configured through
 * `apiKeyHelper` or a `/login` managed key lives in the user's Claude settings, not in the
 * environment — so `apiKeyOverride` is false, the header's switch is hidden, and the badge
 * still (correctly) says "billed per token". That combination was a warning naming no cause
 * and offering no action. With the source reported, the UI can say WHERE the key came from and
 * that BunView cannot strip it, which is the honest version of the same warning.
 *
 * Optional because it is the provider's to report or not: Codex has no equivalent and fakes
 * nothing.
 */
interface EnvOverride {
  apiKeyOverride: boolean
  credentialMode: CredentialMode
  keySource?: string | null
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
