import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  errorCopy,
  type AppState,
  type EffortChoice,
  type ModelChoice,
  type ProviderId,
} from '../../shared/events'
import { openChatStream } from '../lib/api'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Tool names seen during this message, in order. Names only — never inputs. */
  tools: string[]
  /** True while this bubble is still being appended to. */
  streaming: boolean
}

/**
 * `waiting` and `streaming` are separate states, and the distinction earns its keep.
 *
 * Between pressing Send and the first token there can be five to thirty seconds of model
 * queue and thinking, and that gap is exactly where a user decides the app is broken.
 * `waiting` shows a typing indicator with no bubble; `streaming` shows the bubble growing.
 * Collapsing them into one 'busy' state leaves an empty bubble sitting on screen for half a
 * minute, which reads as a bug rather than as progress.
 */
export type StreamPhase = 'idle' | 'waiting' | 'streaming' | 'error'

let messageSeq = 0
const nextId = () => `m${++messageSeq}`

export function useClaudeStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [phase, setPhase] = useState<StreamPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState>({ status: null, notes: [] })

  // Mirrored in a ref so `send` can read the current value without taking it as a dependency
  // and re-creating itself (and every memoised child) after each turn.
  const sessionRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Delta coalescing. A setState per token at ~50 tokens/second re-renders the whole list
  // fifty times a second and turns a long answer into visible jank. Deltas accumulate here
  // and are flushed once per animation frame instead.
  const pending = useRef('')
  const raf = useRef<number | null>(null)

  const flush = useCallback(() => {
    raf.current = null
    const chunk = pending.current
    if (!chunk) return
    pending.current = ''
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      // Only the final message object is rebuilt; the rest of the array stays referentially
      // stable, so React reconciles one bubble rather than the whole list.
      return [...prev.slice(0, -1), { ...last, text: last.text + chunk }]
    })
  }, [])

  const flushNow = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
    flush()
  }, [flush])

  useEffect(() => {
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
      abortRef.current?.abort()
    }
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const reset = useCallback(() => {
    stop()
    pending.current = ''
    setMessages([])
    setError(null)
    setPhase('idle')
    setSessionId(null)
    sessionRef.current = null
  }, [stop])

  /**
   * Send one turn.
   *
   * Runs from an event handler rather than an effect, deliberately: React 18's StrictMode
   * invokes effects twice in development, and an effect-driven send would fire two turns and
   * bill both to the user's plan. This is the obvious refactor to reach for, so it is worth
   * saying why not to.
   */
  const send = useCallback(
    (
      provider: ProviderId,
      prompt: string,
      model: ModelChoice = DEFAULT_MODEL,
      effort: EffortChoice = DEFAULT_EFFORT,
    ) => {
      const trimmed = prompt.trim()
      if (!trimmed || abortRef.current) return

      const ac = new AbortController()
      abortRef.current = ac

      setError(null)
      setPhase('waiting')
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', text: trimmed, tools: [], streaming: false },
        { id: nextId(), role: 'assistant', text: '', tools: [], streaming: true },
      ])

      const run = async () => {
        try {
          for await (const event of openChatStream(
            { provider, prompt: trimmed, sessionId: sessionRef.current, model, effort },
            ac.signal,
          )) {
            switch (event.type) {
              case 'session':
                sessionRef.current = event.sessionId
                setSessionId(event.sessionId)
                break

              case 'delta':
                pending.current += event.text
                if (raf.current === null) raf.current = requestAnimationFrame(flush)
                setPhase((p) => (p === 'waiting' ? 'streaming' : p))
                break

              case 'tool':
                setMessages((prev) => {
                  const last = prev[prev.length - 1]
                  if (!last || last.role !== 'assistant') return prev
                  return [...prev.slice(0, -1), { ...last, tools: [...last.tools, event.name] }]
                })
                break

              case 'state':
                setAppState({ status: event.status, notes: event.notes })
                break

              case 'thinking':
                break

              case 'done':
                if (event.sessionId) {
                  sessionRef.current = event.sessionId
                  setSessionId(event.sessionId)
                }
                break

              case 'error':
                setError(event.message)
                // A user-pressed Stop is not a failure to report as one.
                setPhase(event.code === 'aborted' ? 'idle' : 'error')
                break
            }
          }
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            // Was a ternary whose two branches were the same string. A transport failure and
            // a stream failure read identically to the user, so say so once.
            setError(errorCopy('cli_failed', provider))
            setPhase('error')
          }
        } finally {
          // Flush synchronously: a pending frame that never runs would drop the tail of the
          // answer, and the last chunk is the one the user is waiting to read.
          flushNow()
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            return [...prev.slice(0, -1), { ...last, streaming: false }]
          })
          setPhase((p) => (p === 'error' ? p : 'idle'))
          abortRef.current = null
        }
      }

      void run()
    },
    [flush, flushNow],
  )

  return { messages, phase, error, sessionId, appState, setAppState, send, stop, reset }
}
