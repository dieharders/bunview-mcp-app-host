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
   * Separate from `path` because the two are not interchangeable: a Node-launcher entry point
   * resolves to `[node, codex.js]`, and anything that reconstructs a command from `path` alone
   * would run a `.js` file as if it were an executable. Sign-in reads THIS, not `path`.
   */
  argv: string[]
  /** Absolute path to the executable we would spawn, or null when not installed. */
  path: string | null
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
}

export interface Provider {
  readonly id: ProviderId
  readonly label: string
  detect(): Promise<ProviderDetection>
  authStatus(): Promise<ProviderAuth>
  /** One turn. Must stop its child process when `signal` aborts. */
  stream(opts: StreamOptions, signal: AbortSignal): AsyncGenerator<AppEvent>
}
