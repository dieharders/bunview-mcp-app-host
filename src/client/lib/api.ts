import type { AppEvent, AuthResponse, ChatRequest } from '../../shared/events'

/** Thrown for any non-2xx or network failure. `status` is 0 for a network error. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

export async function fetchAuth(signal?: AbortSignal): Promise<AuthResponse> {
  let res: Response
  try {
    res = await fetch('/api/auth', { signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError('network', 0)
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
  return (await res.json()) as AuthResponse
}

/**
 * Open a chat turn and yield its events as they arrive.
 *
 * `fetch` + a stream reader rather than `EventSource`, for three reasons. EventSource cannot
 * POST, so the prompt would have to travel in a URL — length-capped and logged. It cannot set
 * headers. And decisively, it AUTO-RECONNECTS when the server closes the stream, which for a
 * one-shot completion means it re-fires the entire prompt the instant the answer finishes.
 */
export async function* openChatStream(
  body: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<AppEvent> {
  let res: Response
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    // Distinguish "the user pressed Stop" from "the connection died": the caller shows
    // nothing for the first and an error for the second.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError('network', 0)
  }

  if (!res.ok || !res.body) throw new ApiError(`HTTP ${res.status}`, res.status)

  const reader = res.body.getReader()
  // One decoder for the whole stream, with { stream: true }: model output is full of
  // multi-byte characters, and decoding each chunk independently turns any sequence split
  // across a chunk boundary into U+FFFD. The decoder holds the partial bytes back instead.
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a BLANK LINE, not a newline. Splitting on '\n' would
      // hand JSON.parse a `data: {"type":"del` prefix on any chunk boundary that lands
      // inside a frame — and at ~50 frames a second, boundaries land inside frames
      // constantly.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue // ': ping' heartbeat comment, or a blank run
        try {
          yield JSON.parse(line.slice(5).trim()) as AppEvent
        } catch {
          // A frame we cannot parse is dropped rather than crashing the turn.
        }
      }
    }
  } finally {
    // Stop the server writing into a pipe nobody reads. Reached on an early return too,
    // because abandoning the `for await` calls .return() on this generator.
    reader.cancel().catch(() => {})
  }
}
