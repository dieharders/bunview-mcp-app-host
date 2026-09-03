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
import { CredentialSwitch } from './CredentialSwitch'
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

/**
 * The header's secondary line, when the agent has not set a status of its own.
 *
 * Deliberately says nothing about billing until the probe has answered — the badge beside it
 * owns that, and two half-informed claims in one row is how a user ends up believing the
 * wrong one.
 */
function subtitle(provider: ProviderId, auth: AuthResponse | null): string {
  const label = PROVIDERS[provider].label
  if (auth?.state !== 'ok') return label
  return auth.subscription ? `${label} on your subscription` : `${label} on an API key`
}

export function Chat() {
  const { messages, phase, error, sessionId, appState, setAppState, send, stop, reset } =
    useClaudeStream()

  // `null` means "not chosen yet" and is what gates every probe below. Read lazily so the
  // first render already knows, rather than flashing the picker at a returning user.
  const [provider, setProvider] = useState<ProviderId | null>(readStoredProvider)
  const [auth, setAuth] = useState<AuthResponse | null>(null)
  // The unsent prompt lives here rather than in the composer, so a starter hint in the empty
  // conversation can fill it.
  const [draft, setDraft] = useState('')

  const loadAuth = useCallback(() => {
    if (!provider) return
    setAuth(null)
    fetchAuth(provider)
      .then(setAuth)
      // Not a guess: only the server can see the environment or the mode, and reaching it is
      // exactly what just failed. `apiKeyOverride: false` also hides the credential switch,
      // which is right — offering a choice we cannot carry out would be worse than hiding it.
      .catch(() => setAuth({ state: 'unknown', apiKeyOverride: false, credentialMode: 'auto' }))
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

  const onSend = (
    prompt: string,
    model: ModelChoice,
    effort: EffortChoice,
    settings: Record<string, string>,
  ) => send(provider, prompt, model, effort, settings)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-white">BunView</h1>
        {/* The fallback used to read "… on your subscription" unconditionally, which is a
            claim this app is not always entitled to make: with an API key in the environment
            the CLI prefers it, and the header was asserting the opposite of what was being
            billed. It now says only what is known, and defers to the badge for the rest. */}
        <span className="truncate text-xs text-slate-600">
          {appState.status ?? subtitle(provider, auth)}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <AuthBadge provider={provider} auth={auth} />
          {/* Only renders when there is actually a second credential to switch to. */}
          <CredentialSwitch auth={auth} onChanged={loadAuth} />
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
          <MessageList
            messages={messages}
            waiting={phase === 'waiting'}
            // Only where the starter prompts would actually work: they demonstrate this app's
            // own tools, which not every provider can be given.
            onPickPrompt={PROVIDERS[provider].appTools ? setDraft : undefined}
            className="flex-1"
          />

          {error && (
            <p role="alert" className="px-4 pb-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <div className="p-4 pt-0">
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={onSend}
              onStop={stop}
              busy={busy}
              disabled={!ready}
              provider={provider}
            />
          </div>
        </div>

        <AppStatePanel state={appState} />
      </div>
    </div>
  )
}
