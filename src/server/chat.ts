/**
 * POST /api/chat — one turn, streamed back as server-sent events.
 *
 * One request carries one stream. The alternative shape (POST to create a job, then open an
 * EventSource against a job id) exists to work around EventSource's inability to POST, and
 * costs a token in a query string plus a job registry. Reading the POST response body with a
 * stream reader avoids all of it.
 */
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  ERROR_COPY,
  MODELS,
  type AppEvent,
  type EffortChoice,
  type ModelChoice,
} from '../shared/events'
import { getProvider } from './providers'
import { HEARTBEAT_MS, PING, SSE_HEADERS, frame } from './sse'

/**
 * Windows caps a command line at 32,767 characters and the prompt travels as an argv
 * element. 24k leaves generous headroom for the flags. A prompt genuinely larger than this
 * wants the SDK's streaming-input mode, not a bigger number here.
 */
const MAX_PROMPT_CHARS = 24_000

const badRequest = () =>
  Response.json(
    { type: 'error', code: 'bad_request', message: ERROR_COPY.bad_request } satisfies AppEvent,
    { status: 400 },
  )

export async function handleChat(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return badRequest()

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null

  // Narrowed against the published unions rather than trusted: these reach a subprocess
  // argument list, and an unrecognised value should fall back to the safe default rather
  // than be forwarded.
  const model: ModelChoice = MODELS.includes(body?.model as ModelChoice)
    ? (body?.model as ModelChoice)
    : DEFAULT_MODEL
  const effort: EffortChoice = EFFORTS.includes(body?.effort as EffortChoice)
    ? (body?.effort as EffortChoice)
    : DEFAULT_EFFORT

  // Falls back rather than rejecting: an unknown id is a stale client, not an attack, and the
  // default provider is a safe place to land.
  const provider = getProvider(body?.provider)

  // BOTH disconnect signals, deliberately. `req.signal` is Bun's client-disconnect notice;
  // the stream's own cancel() fires when the response body is torn down. They usually both
  // fire — but "usually" is not good enough when the cost of missing one is an agent process
  // still generating tokens for a window that is gone.
  const ac = new AbortController()
  req.signal.addEventListener('abort', () => ac.abort(), { once: true })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(PING)
        } catch {
          // Stream already closed; the finally block below will clear this interval.
        }
      }, HEARTBEAT_MS)
      ;(heartbeat as unknown as { unref?: () => void }).unref?.()

      try {
        for await (const event of provider.stream(
          { prompt, sessionId, model, effort },
          ac.signal,
        )) {
          controller.enqueue(frame(event))
        }
      } catch (err) {
        console.error('[chat] stream failed:', err)
        try {
          controller.enqueue(
            frame({ type: 'error', code: 'cli_failed', message: ERROR_COPY.cli_failed }),
          )
        } catch {
          // Client is already gone — nothing to report to.
        }
      } finally {
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }
    },

    cancel() {
      ac.abort()
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
