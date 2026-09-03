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
  DEFAULT_PROVIDER,
  PROVIDERS,
  coerceChoice,
  coerceSettings,
  errorCopy,
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

// DEFAULT_PROVIDER because this fires before the body has been parsed far enough to name one
// — and `bad_request` is the one copy that mentions no product, so nothing depends on it.
const badRequest = () =>
  Response.json(
    {
      type: 'error',
      code: 'bad_request',
      message: errorCopy('bad_request', DEFAULT_PROVIDER),
    } satisfies AppEvent,
    { status: 400 },
  )

export async function handleChat(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return badRequest()

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null

  // Falls back rather than rejecting: an unknown id is a stale client, not an attack, and the
  // default provider is a safe place to land.
  const provider = getProvider(body?.provider)

  // Narrowed against THIS PROVIDER'S published lists rather than a global one. These reach a
  // subprocess argument list, and the lists differ per vendor: `opus` is a Claude alias and
  // `minimal` is a Codex effort, so a client holding the other vendor's list — a stale tab, a
  // provider switched mid-session — would otherwise put a value on a command line that
  // rejects it. Unrecognised falls back to the safe default rather than being forwarded.
  const info = PROVIDERS[provider.id]
  const model: ModelChoice = coerceChoice(info.models, body?.model, DEFAULT_MODEL)
  const effort: EffortChoice = coerceChoice(info.efforts, body?.effort, DEFAULT_EFFORT)
  // Same narrowing for the declared extras, plus: anything the provider did not declare is
  // dropped entirely, so a key invented by a client never reaches a provider's flag mapping.
  const settings = coerceSettings(provider.id, body?.settings)

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
          { prompt, sessionId, model, effort, settings },
          ac.signal,
        )) {
          controller.enqueue(frame(event))
        }
      } catch (err) {
        console.error('[chat] stream failed:', err)
        try {
          controller.enqueue(
            frame({
              type: 'error',
              code: 'cli_failed',
              message: errorCopy('cli_failed', provider.id),
            }),
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
