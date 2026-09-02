/**
 * GET /api/auth — is the agent installed, signed in, and on a subscription?
 *
 * Not cached. Asking the binary costs about half a second and it runs once on mount plus on
 * an explicit Retry. A short cache would be stale for exactly the person it matters to: the
 * user who just ran `claude auth login` in a terminal and clicked Retry.
 */
import type { AuthResponse } from '../shared/events'
import { provider } from './providers'

export async function handleAuth(): Promise<Response> {
  const [auth, detection] = await Promise.all([provider.authStatus(), provider.detect()])

  if (auth.state === 'cli_missing') {
    return Response.json({
      state: 'cli_missing',
      searched: detection.searched,
      unresolvedShim: detection.unresolvedShim,
    } satisfies AuthResponse)
  }

  if (auth.state === 'ok') {
    return Response.json({
      state: 'ok',
      account: auth.account,
      plan: auth.plan,
      subscription: auth.subscription,
    } satisfies AuthResponse)
  }

  return Response.json({ state: auth.state } satisfies AuthResponse)
}
