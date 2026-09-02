import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CircleAlert, Download, LogIn, RefreshCw } from 'lucide-react'
import { PROVIDERS, type AuthResponse, type ProviderId } from '../../shared/events'
import { installCli, startLogin } from '../lib/api'
import { Button } from './ui/Button'

/**
 * Everything between "the app opened" and "you can type": install the CLI, then sign in.
 *
 * A banner rather than a modal because the rest of the window stays useful context, and
 * because the same surface has to carry three quite different states without moving around
 * under the user.
 */
export function SetupBanner({
  provider,
  auth,
  onRetry,
}: {
  provider: ProviderId
  auth: AuthResponse | null
  onRetry: () => void
}) {
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState<'install' | 'login' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Abandon an in-flight install if the user switches provider or the app closes; the server
  // sees the disconnect and aborts the download.
  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    setLog([])
    setNote(null)
  }, [provider])

  const install = useCallback(() => {
    const ac = new AbortController()
    abortRef.current = ac
    setBusy('install')
    setNote(null)
    setLog([])

    void (async () => {
      try {
        for await (const event of installCli(provider, ac.signal)) {
          if (event.type === 'log') {
            // Bounded: this is a banner, not a terminal.
            setLog((prev) => [...prev, event.line].slice(-200))
          } else {
            setNote(event.message)
            if (event.ok) onRetry()
          }
        }
      } catch {
        setNote('The install could not be started.')
      } finally {
        setBusy(null)
        abortRef.current = null
      }
    })()
  }, [provider, onRetry])

  const login = useCallback(() => {
    setBusy('login')
    setNote(null)
    void (async () => {
      try {
        const result = await startLogin(provider)
        setNote(result.type === 'done' ? result.message : null)
      } catch {
        setNote(`Couldn’t start sign-in. Run \`${PROVIDERS[provider].loginCommand}\` yourself.`)
      } finally {
        setBusy(null)
      }
    })()
  }, [provider])

  if (!auth || auth.state === 'ok') return null

  const info = PROVIDERS[provider]
  const missing = auth.state === 'cli_missing'

  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-100"
    >
      {missing ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        {auth.state === 'logged_out' && (
          <p>
            {info.label} is installed but not signed in. Sign in to use your {info.plan}{' '}
            subscription.
          </p>
        )}

        {auth.state === 'unknown' && (
          <p>Couldn’t read {info.label}’s status. Check that it runs in a terminal.</p>
        )}

        {missing && (
          <>
            <p>
              {info.label} isn’t installed. BunView can download {info.vendor}’s own signed binary
              and verify its checksum — no npm, no Node, no admin rights. It goes in BunView’s data
              folder, not on your PATH, so uninstalling is deleting a folder.
            </p>
            {auth.unresolvedShim && (
              <p className="mt-1.5">
                Found <Code>{auth.unresolvedShim}</Code> but not the executable it points at. Set{' '}
                <Code>BUNVIEW_{provider.toUpperCase()}_PATH</Code> to the real binary.
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

        {log.length > 0 && (
          <pre className="scrollbar-slim mt-2 max-h-32 overflow-y-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-amber-200/70">
            {log.join('\n')}
          </pre>
        )}

        {note && <p className="mt-2 text-amber-200">{note}</p>}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5">
        {missing && auth.canInstall && (
          <Button size="sm" onClick={install} loading={busy === 'install'} disabled={busy !== null}>
            <Download className="size-3.5" aria-hidden />
            Install
          </Button>
        )}

        {/* Signing in needs the binary, so it only appears once there is one to run. */}
        {!missing && (
          <Button size="sm" onClick={login} loading={busy === 'login'} disabled={busy !== null}>
            <LogIn className="size-3.5" aria-hidden />
            Sign in
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={onRetry} disabled={busy !== null}>
          <RefreshCw className="size-3.5" aria-hidden />
          Retry
        </Button>
      </div>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px]">{children}</code>
}
