import { AlertTriangle, CircleAlert, RefreshCw } from 'lucide-react'
import type { AuthResponse } from '../../shared/events'
import { cn } from '../lib/cn'
import { Button } from './ui/Button'
import { Spinner } from './ui/Spinner'

/**
 * Whether the app can talk to Claude, and on whose dime.
 *
 * The `subscription` distinction is the reason this is a badge rather than a boolean: an API
 * key works perfectly well and would look identical, while billing per token instead of
 * against the user's plan. Saying which is in play is the honest thing to show.
 */
export function AuthBadge({ auth }: { auth: AuthResponse | null }) {
  if (!auth) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-slate-500">
        <Spinner className="size-3.5" />
        Checking Claude Code…
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
              Claude {auth.plan ?? 'subscription'}
              {auth.account && <span className="text-slate-500"> · {auth.account}</span>}
            </>
          ) : (
            <span className="text-amber-200">API key — usage is billed per token</span>
          )}
        </span>
      </span>
    )
  }

  // Problems get a compact chip here and the full explanation in AuthProblem below the
  // header. Putting the whole card in the header made it overflow the window: a header is a
  // single fixed-height row and the card is several lines of prose plus a path list.
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className="size-2 rounded-full bg-amber-400" aria-hidden />
      <span className="text-amber-200">{SHORT_LABEL[auth.state]}</span>
    </span>
  )
}

const SHORT_LABEL: Record<'logged_out' | 'cli_missing' | 'unknown', string> = {
  logged_out: 'Not signed in',
  cli_missing: 'Claude Code not found',
  unknown: 'Status unknown',
}

/**
 * The full explanation for a broken setup, as a banner.
 *
 * Separate from the badge because this is the one screen a first-run user will actually have
 * to read, and it needs the width to say what to type and where the app already looked.
 */
export function AuthProblem({ auth, onRetry }: { auth: AuthResponse | null; onRetry: () => void }) {
  if (!auth || auth.state === 'ok') return null

  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-100"
    >
      {auth.state === 'cli_missing' ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        {auth.state === 'logged_out' && (
          <p>
            Claude Code isn’t signed in. Run <Code>claude auth login</Code> in a terminal, then
            retry.
          </p>
        )}

        {auth.state === 'unknown' && (
          <p>Couldn’t read Claude Code’s auth status. Check that the CLI runs in a terminal.</p>
        )}

        {auth.state === 'cli_missing' && (
          <>
            <p>
              Claude Code not found. Install it with{' '}
              <Code>npm install -g @anthropic-ai/claude-code</Code>, then sign in with{' '}
              <Code>claude auth login</Code>.
            </p>
            {auth.unresolvedShim && (
              <p className="mt-1.5">
                Found <Code>{auth.unresolvedShim}</Code> but not the executable it points at. Set{' '}
                <Code>BUNVIEW_CLAUDE_PATH</Code> to the real <Code>claude.exe</Code>.
              </p>
            )}
            {/* The searched list is the whole point of this state: it turns "it doesn't work"
                into "it looked in ~/.local/bin and mine is in ~/bin". */}
            {auth.searched.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-amber-200/80">
                  Searched {auth.searched.length} location{auth.searched.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-amber-200/70">
                  {auth.searched.map((path) => (
                    <li key={path} className="wrap-break-word">
                      {path}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>

      <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
        <RefreshCw className="size-3.5" aria-hidden />
        Retry
      </Button>
    </div>
  )
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px]">{children}</code>
}
