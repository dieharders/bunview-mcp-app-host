/**
 * Which credential the spawned CLI may use — and, crucially, who decides.
 *
 * WHY THIS IS RUNTIME STATE AND NOT A CONSTANT IN config.ts.
 *
 * Anthropic's terms for running Claude Code inside another product are explicit that the
 * binary is used as published and that the host may not "remove, disable, or restrict any
 * authentication method built into it (including methods that permit signing in with a Claude
 * account **or the user's own API key**)".
 *
 * This app used to delete `ANTHROPIC_API_KEY` from every child environment unconditionally,
 * with the opt-out buried in an environment variable no end user would ever find. The intent
 * was good — being silently billed per token by an app that advertises itself as running on
 * your subscription is a genuine footgun — but the mechanism disabled one of the binary's
 * built-in authentication methods by default, which is the thing the terms name.
 *
 * So the protection moved from a default to a CHOICE, and the choice lives here because it has
 * to be changeable while the app is running:
 *
 *   * `auto`         — pass the environment through untouched. The CLI applies its own
 *                      precedence, which prefers an API key when one is present. This is
 *                      "Claude Code as published", and it is the default.
 *   * `subscription` — strip the overrides from the children BunView spawns, so the user's
 *                      plan is what gets billed.
 *
 * Neither mode is hidden. `GET /api/auth` reports the mode alongside which credential is
 * ACTUALLY in play, and the header offers a one-click switch whenever both are available — so
 * the user gets the protection without the app quietly making the decision for them.
 *
 * Scope: BunView's own children only. The sign-in terminal is the user's login shell and is
 * deliberately untouched by any of this. See `terminal.ts`.
 */
import { CREDENTIAL_MODES, type CredentialMode } from '../shared/events'
import { config } from './config'

export const isCredentialMode = (v: unknown): v is CredentialMode =>
  typeof v === 'string' && (CREDENTIAL_MODES as readonly string[]).includes(v)

/**
 * Seeded from config, then owned here.
 *
 * Deliberately process-wide rather than per-request: it decides what a spawned CLI is billed
 * to, and a per-request value would let an auth probe and the chat turn it describes disagree
 * — the badge saying "Max" while the message was billed to a key.
 */
let mode: CredentialMode = config.credentialMode

export const getCredentialMode = (): CredentialMode => mode

export function setCredentialMode(next: CredentialMode): CredentialMode {
  mode = next
  return mode
}

/**
 * POST /api/credentials — switch between the plan and an API key.
 *
 * Returns the mode that is now in effect. The client re-probes `GET /api/auth` afterwards
 * rather than trusting this response to describe the outcome, because what the CLI does with
 * the environment is the CLI's answer to give, not ours to predict.
 */
export async function handleCredentials(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { mode?: unknown } | null

  if (!isCredentialMode(body?.mode)) {
    return new Response('unknown credential mode', { status: 400 })
  }

  return Response.json({ mode: setCredentialMode(body.mode) })
}
