import { PROVIDERS, type AuthResponse, type ProviderId } from '../../shared/events'
import { cn } from '../lib/cn'
import { Spinner } from './ui/Spinner'

/**
 * Whether the app can talk to the chosen provider, and ON WHOSE DIME.
 *
 * The second half is the whole reason this is a badge rather than a boolean. An API key works
 * perfectly well and produces an identical-looking conversation while billing per token
 * instead of against the user's plan. Both states therefore name the credential OUT LOUD —
 * neither is allowed to be the silent one, because "no warning" is not a thing a user can
 * distinguish from "not looked at yet".
 *
 * The signal comes from the CLI's own `apiKeySource`, not from this app's guess at which
 * variable the vendor would have preferred. See `readAuthStatus` in providers/claude.ts: with
 * a key exported, every other field still says "max", so a badge built on those alone shows
 * green over a session billed per token.
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
    // Named in BOTH branches so the two are directly comparable, rather than one reading as a
    // status and the other as a warning. Only the API-key side spells out the consequence,
    // because "Max plan" already states what is paying while "API key" does not say at whose
    // expense.
    const credential = auth.subscription
      ? `${auth.plan ?? 'subscription'} plan`
      : 'API key — billed per token'

    // The visible text is split across spans for styling, which leaves a screen reader to
    // stitch "Claude Code", "·", "Max plan" together and gives tests nothing stable to assert
    // on. One `aria-label` states the whole thing — what is connected, and what pays for it.
    const summary = auth.subscription
      ? `${label}, using your ${auth.plan ?? 'subscription'} plan${auth.account ? `, signed in as ${auth.account}` : ''}`
      : `${label}, using an API key — billed per token${auth.account ? `, signed in as ${auth.account}` : ''}`

    return (
      <span
        role="status"
        aria-label={summary}
        className="inline-flex items-center gap-2 text-xs"
        title={
          auth.subscription
            ? `${label} is signed in and using your ${auth.plan ?? 'subscription'} plan. Usage counts against that plan's limits.`
            : `${label} is using an API key, so usage is billed per token rather than against your plan.`
        }
      >
        <span
          className={cn(
            'size-2 rounded-full',
            auth.subscription ? 'bg-emerald-400' : 'bg-amber-400',
          )}
          aria-hidden
        />
        {/* The provider label stays HERE and not only in the header subtitle, because the
            subtitle is replaced the moment an MCP tool sets an app status — which is most of
            the time in a working session. Without it the badge would say "Max plan" with
            nothing on screen naming whose plan. */}
        <span className={auth.subscription ? 'text-slate-300' : 'text-amber-200'}>
          {label}
          {' · '}
          {/* Capitalised for the plan case ("Max plan"); the key case is already cased. */}
          <span className={auth.subscription ? 'capitalize' : undefined}>{credential}</span>
          {/* The account is kept in BOTH states. It used to be dropped on the API-key path,
              which is exactly when a user most needs to know which login they are looking at
              — the key and the signed-in account can belong to different people. */}
          {auth.account && (
            <span className={auth.subscription ? 'text-slate-500' : 'text-amber-200/70'}>
              {' · '}
              {auth.account}
            </span>
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
