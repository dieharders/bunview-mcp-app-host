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

export interface ChatRequest {
  prompt: string
  sessionId: string | null
  model: ModelChoice
  effort: EffortChoice
}

/** Shape of `GET /api/auth`. Mirrors the provider's auth report, narrowed for the browser. */
export type AuthResponse =
  | { state: 'ok'; account: string | null; plan: string | null; subscription: boolean }
  | { state: 'logged_out' }
  | { state: 'cli_missing'; searched: string[]; unresolvedShim: string | null }
  | { state: 'unknown' }

export interface AppState {
  status: string | null
  notes: string[]
}
