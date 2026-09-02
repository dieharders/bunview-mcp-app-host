import { useCallback, useEffect, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import type { AppState, AuthResponse } from '../../shared/events'
import { useClaudeStream } from '../hooks/useClaudeStream'
import { fetchAuth } from '../lib/api'
import { AppStatePanel } from './AppStatePanel'
import { AuthBadge, AuthProblem } from './AuthBadge'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { Button } from './ui/Button'

export function Chat() {
  const { messages, phase, error, sessionId, appState, setAppState, send, stop, reset } =
    useClaudeStream()
  const [auth, setAuth] = useState<AuthResponse | null>(null)

  const loadAuth = useCallback(() => {
    const ac = new AbortController()
    setAuth(null)
    fetchAuth(ac.signal)
      .then(setAuth)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setAuth({ state: 'unknown' })
      })
    return () => ac.abort()
  }, [])

  useEffect(() => loadAuth(), [loadAuth])

  // Seed the panel with whatever the server already holds, so a reload does not appear to
  // wipe state the agent set earlier. Live updates arrive on the chat stream instead of by
  // polling — see the `state` event in useClaudeStream.
  useEffect(() => {
    const ac = new AbortController()
    fetch('/api/state', { signal: ac.signal })
      .then((r) => r.json() as Promise<AppState>)
      .then(setAppState)
      .catch(() => {})
    return () => ac.abort()
  }, [setAppState])

  const busy = phase === 'waiting' || phase === 'streaming'
  const ready = auth?.state === 'ok'

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-white">BunView</h1>
        <span className="text-xs text-slate-600">
          {appState.status ?? 'Claude on your subscription'}
        </span>

        <div className="ml-auto flex items-center gap-3">
          <AuthBadge auth={auth} />
          {sessionId && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              <MessageSquarePlus className="size-3.5" aria-hidden />
              New chat
            </Button>
          )}
        </div>
      </header>

      <AuthProblem auth={auth} onRetry={loadAuth} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageList messages={messages} waiting={phase === 'waiting'} className="flex-1" />

          {error && (
            <p role="alert" className="px-4 pb-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <div className="p-4 pt-0">
            <Composer onSend={send} onStop={stop} busy={busy} disabled={!ready} />
          </div>
        </div>

        <AppStatePanel state={appState} />
      </div>
    </div>
  )
}
