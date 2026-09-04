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
import { getCredentialMode } from './credentials'
import { hadApiKeyOverride } from './env'
import { getProvider } from './providers'
import { resetDiscovery } from './providers/discovery'
import { canInstall } from './setup'

export async function handleAuth(req: Request): Promise<Response> {
  const provider = getProvider(new URL(req.url).searchParams.get('provider'))

  // Discovery memoises for the life of the process, so "not cached" above was only half true:
  // the auth answer was fresh but the location it was based on was not. A user who installed
  // the CLI themselves — in the very terminal a sign-in just opened — pressed Retry and got
  // "isn't installed" until the app restarted. Retry is the one moment the filesystem is known
  // to have changed, so it is the right place to spend the probe again.
  resetDiscovery()

  const [auth, detection] = await Promise.all([provider.authStatus(), provider.detect()])

  // Reported in every state, because the state it matters most in is `logged_out` — the user
  // is one click from a sign-in that their own shell may quietly redirect. The mode rides
  // along so the header knows which way to offer the switch; `apiKeyOverride` decides whether
  // to offer it at all, since with no key present there is no second option to switch to.
  //
  // `keySource` rides along for the case `apiKeyOverride` cannot see: a key from `apiKeyHelper`
  // or a managed `/login` key is in the user's Claude settings, not the environment, so the
  // override flag is false and the switch stays hidden while the badge still says "billed per
  // token". Naming the source is what turns that into a warning the user can act on.
  //
  // Read AFTER `provider.authStatus()`, never before: that call can move the mode, dropping
  // back to `auto` for a user whose only credential is the key it would otherwise have
  // stripped. Reading first would report `subscription` over a response proving otherwise.
  const env = {
    apiKeyOverride: hadApiKeyOverride(provider.id),
    credentialMode: getCredentialMode(),
    keySource: auth.keySource ?? null,
  }

  if (auth.state === 'cli_missing') {
    return Response.json({
      state: 'cli_missing',
      searched: detection.searched,
      unresolvedShim: detection.unresolvedShim,
      // Whether to offer the Install button at all. Decided on the server because the
      // preconditions are the server's to know.
      canInstall: canInstall(provider.id),
      ...env,
    } satisfies AuthResponse)
  }

  if (auth.state === 'ok') {
    return Response.json({
      state: 'ok',
      account: auth.account,
      plan: auth.plan,
      subscription: auth.subscription,
      ...env,
    } satisfies AuthResponse)
  }

  return Response.json({ state: auth.state, ...env } satisfies AuthResponse)
}
