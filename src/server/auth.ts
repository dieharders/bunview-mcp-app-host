/**
 * GET /api/auth?provider=<id> — is that vendor's CLI installed, signed in, and on a
 * subscription?
 *
 * The provider is a required-ish query parameter rather than server state because the user
 * chooses it in the UI, and probing a vendor means spawning their CLI to read their account.
 * Nothing here runs until the user has picked one.
 *
 * Not cached. Asking the binary costs about half a second and it runs once on mount plus on
 * an explicit Retry. A short cache would be stale for exactly the person it matters to: the
 * user who just finished signing in and pressed Retry.
 */
import type { AuthResponse } from '../shared/events'
import { getProvider } from './providers'
import { canInstall } from './setup'

export async function handleAuth(req: Request): Promise<Response> {
  const provider = getProvider(new URL(req.url).searchParams.get('provider'))
  const [auth, detection] = await Promise.all([provider.authStatus(), provider.detect()])

  if (auth.state === 'cli_missing') {
    return Response.json({
      state: 'cli_missing',
      searched: detection.searched,
      unresolvedShim: detection.unresolvedShim,
      // Whether to offer the Install button at all. Decided on the server because the
      // preconditions are the server's to know.
      canInstall: canInstall(provider.id),
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
