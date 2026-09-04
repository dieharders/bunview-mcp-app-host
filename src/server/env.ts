/**
 * The environment every child process gets.
 *
 * The premise of this scaffold is that it runs on the user's Claude Pro/Max subscription:
 * `claude auth login` writes OAuth credentials to disk, the agent binary reads them at spawn
 * time, and usage bills against the plan. But the CLI PREFERS an API key when one is present
 * in the environment — so a developer who happens to have `ANTHROPIC_API_KEY` exported for
 * unrelated work gets billed per token by an app that says it runs on their subscription.
 *
 * WHAT BOUNDS THE STRIP.
 *
 * The obvious fix — delete those variables from every child — is what this file does, and it
 * is the default. But it cannot be an UNCONDITIONAL default: Anthropic's terms for running
 * Claude Code inside another product say the host may not "remove, disable, or restrict any
 * authentication method built into it (including methods that permit signing in with a Claude
 * account or the user's own API key)".
 *
 * The strip survives as a default because two things keep the key method reachable rather than
 * removed, and neither is optional:
 *
 *   1. The user can turn it off in one click from the header, and the badge tells them the
 *      truth about which credential is live meanwhile. See `credentials.ts` for the mode.
 *   2. It never takes the LAST credential. `providers/claude.ts` probes with the strip applied
 *      and again without it, and drops the whole app back to `auto` for a user whose only
 *      credential is the key — rather than reporting them signed-out over a login this file
 *      hid from the binary.
 *
 * Rule 2 is the one that is easy to delete by accident, because nothing fails loudly when it
 * goes: the user just sees "not signed in" forever.
 *
 * The one place none of this reaches is the sign-in TERMINAL, which is the user's own login
 * shell by design; `hadApiKeyOverride` exists so the UI can say so rather than pretend
 * otherwise. See `terminal.ts`.
 */
import { getCredentialMode } from './credentials'
import type { ProviderId } from '../shared/events'

/** Variables that would redirect auth away from the subscription credential. */
const OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const

export function childEnv(): Record<string, string | undefined> {
  // Must spread process.env: the Agent SDK's `env` option REPLACES the subprocess
  // environment rather than merging into it, so anything omitted here is simply gone —
  // including PATH, HOME and USERPROFILE, without which the binary cannot find its own
  // credentials.
  const env: Record<string, string | undefined> = { ...process.env }

  // `auto` hands the binary the environment as the user actually has it and lets the vendor's
  // own precedence decide. Only an explicit choice removes anything.
  if (getCredentialMode() !== 'subscription') return env

  for (const key of OVERRIDES) delete env[key]
  return env
}

/**
 * True when the environment holds a variable that COULD redirect billing away from the
 * subscription — regardless of the current mode, and regardless of whether it won.
 *
 * This is the "is there a choice to make here" predicate, not the "which one won" predicate.
 * The second question is answered by the CLI itself, via `apiKeySource` in its auth status;
 * asking the environment would only ever be a guess at the vendor's precedence rules.
 *
 * Takes the provider because every variable in OVERRIDES is one of Anthropic's — none of them
 * changes what Codex does, so reporting one to a Codex user would be a warning about nothing.
 */
export function hadApiKeyOverride(provider: ProviderId): boolean {
  if (provider !== 'claude') return false
  return OVERRIDES.some((k) => Boolean(process.env[k]))
}
