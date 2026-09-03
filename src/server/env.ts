/**
 * The environment every child process gets.
 *
 * `ANTHROPIC_API_KEY` and friends are STRIPPED, and that is the whole point of this file.
 *
 * The premise of this scaffold is that it runs on the user's Claude Pro/Max subscription:
 * `claude auth login` writes OAuth credentials to disk, the agent binary reads them at spawn
 * time, and usage bills against the plan. But the CLI PREFERS an API key when one is present
 * in the environment. So a developer who happens to have `ANTHROPIC_API_KEY` exported for
 * unrelated work would be silently billed per token by an app that advertises itself as
 * running on their subscription — with no visible symptom until the invoice.
 *
 * Set `BUNVIEW_ALLOW_API_KEY=1` to opt back in deliberately.
 *
 * Stripping covers every CLI this app spawns — chat turns and status probes alike — so what
 * it runs is never billed to a key. The one place it cannot reach is the sign-in TERMINAL,
 * which is the user's own login shell by design; `hadApiKeyOverride` exists so the UI can say
 * so rather than pretend otherwise. See `terminal.ts`.
 */
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

  if (process.env.BUNVIEW_ALLOW_API_KEY === '1') return env

  for (const key of OVERRIDES) delete env[key]
  return env
}

/**
 * True when the environment would have redirected billing away from the subscription.
 *
 * Takes the provider because every variable in OVERRIDES is one of Anthropic's — none of them
 * changes what Codex does, so reporting one to a Codex user would be a warning about nothing.
 */
export function hadApiKeyOverride(provider: ProviderId): boolean {
  if (provider !== 'claude') return false
  return OVERRIDES.some((k) => Boolean(process.env[k]))
}
