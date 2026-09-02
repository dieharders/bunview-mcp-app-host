/**
 * Translate the agent's message stream into `AppEvent`s.
 *
 * This is the only place in the project that knows what the agent's messages look like. See
 * the header of `src/shared/events.ts` for why the translation exists at all rather than
 * forwarding the messages straight to the browser.
 *
 * The governing rule: anything unrecognised is DROPPED, never passed through. An SDK release
 * that adds a message type must be a no-op here — not a crash, and not a leak of a shape
 * nobody has looked at.
 */
import type { AppEvent } from '../../shared/events'
import { ERROR_COPY } from '../../shared/events'

/**
 * Only the fields we read.
 *
 * Deliberately not a full model of the SDK's schema: modelling it completely would claim a
 * stability the format does not have, and would need updating on every release whether or
 * not we care about what changed.
 */
interface AgentMessage {
  type?: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  duration_ms?: number
  event?: {
    type?: string
    delta?: { type?: string; text?: string }
    content_block?: { type?: string; name?: string }
  }
}

export interface MapState {
  sessionId: string | null
}

export function mapMessage(raw: unknown, state: MapState): AppEvent[] {
  if (typeof raw !== 'object' || raw === null) return []
  const msg = raw as AgentMessage

  if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
    state.sessionId = msg.session_id
    return [{ type: 'session', sessionId: msg.session_id }]
  }

  if (msg.type === 'stream_event' && msg.event) {
    const event = msg.event

    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        return [{ type: 'delta', text: event.delta.text }]
      }
      // Dropped: `input_json_delta` carries tool INPUTS, and an Edit or Write tool's input is
      // file contents. `thinking_delta` carries extended-thinking prose — we announce the
      // block below, but not what it says.
      return []
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type === 'tool_use' && block.name) return [{ type: 'tool', name: block.name }]
      if (block?.type === 'thinking') return [{ type: 'thinking' }]
      return []
    }

    // message_start / message_delta / message_stop / content_block_stop are bookkeeping with
    // no meaning to the UI.
    return []
  }

  // Complete assistant messages. Dropped because every character in them has ALREADY been
  // streamed as a delta — forwarding them renders the whole answer a second time.
  if (msg.type === 'assistant' || msg.type === 'user') return []

  if (msg.type === 'result') {
    if (typeof msg.session_id === 'string') state.sessionId = msg.session_id
    if (msg.is_error) {
      return [{ type: 'error', code: 'cli_failed', message: ERROR_COPY.cli_failed }]
    }
    return [
      {
        type: 'done',
        sessionId: state.sessionId,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
      },
    ]
  }

  return []
}
