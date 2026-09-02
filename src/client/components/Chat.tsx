import { useCallback, useEffect, useState } from 'react'
import { MessageSquarePlus, Repeat } from 'lucide-react'
import {
  PROVIDERS,
  PROVIDER_IDS,
  type AppState,
  type AuthResponse,
  type EffortChoice,
  type ModelChoice,
  type ProviderId,
} from '../../shared/events'
import { useClaudeStream } from '../hooks/useClaudeStream'
import { fetchAuth } from '../lib/api'
import { AppStatePanel } from './AppStatePanel'
import { AuthBadge } from './AuthBadge'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { ProviderPicker } from './ProviderPicker'
import { SetupBanner } from './SetupBanner'
import { Button } from './ui/Button'

const PROVIDER_KEY = 'bunview.provider'

/**
 * Read the remembered provider.
 *
 * Wrapped because storage access throws outright in some contexts (private windows with site
 * data blocked, and the test DOM), and a scaffold that white-screens on a storage exception
 * would be a poor thing to fork.
 */
function readStoredProvider(): ProviderId | null {
  try {
    const saved = localStorage.getItem(PROVIDER_KEY)
    return PROVIDER_IDS.includes(saved as ProviderId) ? (saved as ProviderId) : null
  } catch {
    return null
  }
}

export function Chat() {
  const { messages, phase, error, sessionId, appState, setAppState, send, stop, reset } =
    useClaudeStream()

  // `null` means "not chosen yet" and is what gates every probe below. Read lazily so the
  // first render already knows, rather than flashing the picker at a returning user.
  const [provider, setProvider] = useState<ProviderId | null>(readStoredProvider)
  const [auth, setAuth] = useState<AuthResponse | null>(null)

  const loadAuth = useCallback(() => {
    if (!provider) return
    setAuth(null)
    fetchAuth(provider)
      .then(setAuth)
      .catch(() => setAuth({ state: 'unknown' }))
  }, [provider])

  useEffect(() => loadAuth(), [loadAuth])

  // Seed the panel with whatever the server already holds, so a reload does not appear to wipe
  // state the agent set earlier. Live updates arrive on the chat stream instead of by polling.
  useEffect(() => {
    if (!provider) return
    const ac = new AbortController()
    fetch('/api/state', { signal: ac.signal })
      .then((r) => r.json() as Promise<AppState>)
      .then(setAppState)
      .catch(() => {})
    return () => ac.abort()
  }, [provider, setAppState])

  const choose = useCallback(
    (id: ProviderId) => {
      try {
        localStorage.setItem(PROVIDER_KEY, id)
      } catch {
        // Not remembering the choice is survivable; refusing to accept it is not.
      }
      reset()
      setAuth(null)
      setProvider(id)
    },
    [reset],
  )

  const switchProvider = useCallback(() => {
    try {
      localStorage.removeItem(PROVIDER_KEY)
    } catch {
      // See above.
    }
    reset()
    setAuth(null)
    setProvider(null)
  }, [reset])

  // Nothing is probed and no CLI is spawned until a provider is chosen.
  if (!provider) return <ProviderPicker onChoose={choose} />

  const busy = phase === 'waiting' || phase === 'streaming'
  const ready = auth?.state === 'ok'

  const onSend = (prompt: string, model: ModelChoice, effort: EffortChoice) =>
    send(provider, prompt, model, effort)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-white">BunView</h1>
        <span className="truncate text-xs text-slate-600">
          {appState.status ?? `${PROVIDERS[provider].label} on your subscription`}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <AuthBadge provider={provider} auth={auth} />
          <Button variant="ghost" size="sm" onClick={switchProvider} disabled={busy}>
            <Repeat className="size-3.5" aria-hidden />
            Switch
          </Button>
          {sessionId && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              <MessageSquarePlus className="size-3.5" aria-hidden />
              New chat
            </Button>
          )}
        </div>
      </header>

      <SetupBanner provider={provider} auth={auth} onRetry={loadAuth} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageList messages={messages} waiting={phase === 'waiting'} className="flex-1" />

          {error && (
            <p role="alert" className="px-4 pb-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <div className="p-4 pt-0">
            <Composer
              onSend={onSend}
              onStop={stop}
              busy={busy}
              disabled={!ready}
              providerLabel={PROVIDERS[provider].label}
            />
          </div>
        </div>

        <AppStatePanel state={appState} />
      </div>
    </div>
  )
}
