/**
 * The provider seam.
 *
 * Three methods and one event type. That is the entire contract, and it is small on purpose:
 * the value of this interface is that `stream` yields ONLY `AppEvent`, which is what keeps
 * anything Claude-shaped out of the browser. Adding a Codex or Gemini CLI is then one new
 * file implementing this, plus one changed line in ./index.ts.
 *
 * Deliberately NOT in here: model lists, token counting, tool registration, MCP config, a
 * multi-turn message array, cost accounting, retry policy, streaming input. Each of those is
 * a real feature of some provider and none of them is needed to render a chat window.
 */
import type { AppEvent, EffortChoice, ModelChoice, ProviderId } from '../../shared/events'

export interface ProviderDetection {
  /**
   * The resolved argv prefix, ready to spawn. Empty when not installed.
   *
   * The ONLY representation of "what do I run" in this contract. A single path cannot express
   * it: a Node-launcher entry point resolves to `[node, codex.js]`, and anything that
   * reconstructs a command from that path alone runs a `.js` file as if it were an executable.
   * `Discovery` still carries a `path` for the one API that demands a single string (the Agent
   * SDK's `pathToClaudeCodeExecutable`); nothing else should reach for it, and it is kept out
   * of this interface so nothing accidentally can.
   */
  argv: string[]
  /** Every location tried, in order. A provider returning [] makes its own failure
   *  undiagnosable, so this is part of the contract rather than a debug extra. */
  searched: string[]
  /** Provider-specific hint when something was found but could not be used. */
  unresolvedShim: string | null
}

export interface ProviderAuth {
  state: 'ok' | 'logged_out' | 'cli_missing' | 'unknown'
  /** Plan tier as the provider names it ('max', 'pro', …), or null. */
  plan: string | null
  /** The signed-in account, or null when the provider does not report one. */
  account: string | null
  /**
   * True for a subscription, false for metered API-key billing. The distinction this whole
   * project exists for, so it belongs in the interface rather than in a Claude-shaped field
   * that a second provider would have to fake.
   */
  subscription: boolean
  /**
   * The provider's own name for the credential in play ('ANTHROPIC_API_KEY', 'apiKeyHelper',
   * '/login managed key'), or null on a plain subscription login.
   *
   * Optional, and that is the point: it is what a provider CAN say about where a key came
   * from, not something every provider must invent. Codex omits it rather than faking one.
   *
   * `subscription` above answers "is the plan paying"; this answers "and if not, from where" —
   * which is the difference between a warning the user can act on and an amber badge with no
   * named cause. A key from `apiKeyHelper` is invisible to `hadApiKeyOverride`, because it is
   * in the user's Claude settings rather than the environment, so nothing else in the app can
   * tell that case apart from an exported variable.
   */
  keySource?: string | null
}

export interface StreamOptions {
  prompt: string
  /**
   * Continue a prior turn. PROVIDER-OPAQUE: it came out of a `session` event from this same
   * provider and goes straight back in. Nothing else may parse or construct it.
   */
  sessionId: string | null
  model: ModelChoice
  effort: EffortChoice
  /**
   * The provider's own declared extras, already coerced against `PROVIDERS[id].settings`.
   *
   * A bag rather than named fields because the set differs per vendor — Claude has a thinking
   * mode, Codex has verbosity and reasoning summaries — and naming them here would put every
   * vendor's knobs in every vendor's interface. Each provider reads only the ids it declared;
   * `chat.ts` has already dropped everything else.
   */
  settings: Record<string, string>
}

export interface Provider {
  readonly id: ProviderId
  readonly label: string
  detect(): Promise<ProviderDetection>
  authStatus(): Promise<ProviderAuth>
  /** One turn. Must stop its child process when `signal` aborts. */
  stream(opts: StreamOptions, signal: AbortSignal): AsyncGenerator<AppEvent>
}
