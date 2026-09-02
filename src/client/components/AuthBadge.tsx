import { PROVIDERS, type AuthResponse, type ProviderId } from '../../shared/events'
import { cn } from '../lib/cn'
import { Spinner } from './ui/Spinner'

/**
 * Whether the app can talk to the chosen provider, and on whose dime.
 *
 * The `subscription` distinction is why this is a badge rather than a boolean: an API key
 * works perfectly well and would look identical, while billing per token instead of against
 * the user's plan. Saying which is in play is the honest thing to show.
 *
 * Problems get a compact chip here and the full explanation in SetupBanner below the header.
 * Putting the whole card in the header made it overflow the window — a header is one
 * fixed-height row, and that card is several lines of prose plus a list of paths.
 */
export function AuthBadge({ provider, auth }: { provider: ProviderId; auth: AuthResponse | null }) {
  const label = PROVIDERS[provider].label

  if (!auth) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-slate-500">
        <Spinner className="size-3.5" />
        Checking {label}…
      </span>
    )
  }

  if (auth.state === 'ok') {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span
          className={cn(
            'size-2 rounded-full',
            auth.subscription ? 'bg-emerald-400' : 'bg-amber-400',
          )}
          aria-hidden
        />
        <span className="text-slate-300">
          {auth.subscription ? (
            <>
              {label} {auth.plan ?? 'subscription'}
              {auth.account && <span className="text-slate-500"> · {auth.account}</span>}
            </>
          ) : (
            <span className="text-amber-200">API key — usage is billed per token</span>
          )}
        </span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className="size-2 rounded-full bg-amber-400" aria-hidden />
      <span className="text-amber-200">
        {auth.state === 'logged_out' && 'Not signed in'}
        {auth.state === 'cli_missing' && `${label} not found`}
        {auth.state === 'unknown' && 'Status unknown'}
      </span>
    </span>
  )
}
