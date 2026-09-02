/**
 * Server-sent-events framing.
 *
 * Deliberately hand-rolled and tiny: SSE is four lines of string formatting, and the frames
 * are read back by our own `openChatStream` rather than by `EventSource` (which cannot POST
 * and re-fires the request when the server closes the stream).
 */
import type { AppEvent } from '../shared/events'

const encoder = new TextEncoder()

export const frame = (event: AppEvent): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

/**
 * A comment frame. Carries no data — its only job is to put bytes on the wire so the
 * connection is not idle.
 *
 * Needed because `Bun.serve({ idleTimeout })` is a ceiling as well as a floor: 120s covers
 * the usual quiet between "prompt sent" and "first token", but a long thinking phase or a
 * slow tool can exceed it. A ping every 15s resets the timer indefinitely. The idleTimeout
 * bump and this heartbeat are both required; neither alone is sufficient.
 */
export const PING = encoder.encode(': ping\n\n')
export const HEARTBEAT_MS = 15_000

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Harmless here (nothing sits between a webview and localhost) but correct if this server
  // is ever put behind a proxy that buffers by default.
  'x-accel-buffering': 'no',
} as const
