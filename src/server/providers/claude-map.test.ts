import { describe, expect, test } from 'bun:test'
import { mapMessage, type MapState } from './claude-map'

const fresh = (): MapState => ({ sessionId: null })

describe('mapMessage', () => {
  test('captures the session id from the init message', () => {
    const state = fresh()
    const events = mapMessage({ type: 'system', subtype: 'init', session_id: 'abc' }, state)

    expect(events).toEqual([{ type: 'session', sessionId: 'abc' }])
    expect(state.sessionId).toBe('abc')
  })

  test('extracts text deltas', () => {
    const events = mapMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      },
      fresh(),
    )

    expect(events).toEqual([{ type: 'delta', text: 'hi' }])
  })

  test('reports a tool call by NAME and never its input', () => {
    const events = mapMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Read', input: { file_path: '/etc/passwd' } },
        },
      },
      fresh(),
    )

    expect(events).toEqual([{ type: 'tool', name: 'Read' }])
    expect(JSON.stringify(events)).not.toContain('passwd')
  })

  test('drops input_json_delta — tool inputs are file contents for Edit/Write', () => {
    const events = mapMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"content":"secret"' },
        },
      },
      fresh(),
    )

    expect(events).toEqual([])
  })

  test('drops complete assistant messages — the text already streamed as deltas', () => {
    const events = mapMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      fresh(),
    )

    expect(events).toEqual([])
  })

  test('maps result to done, carrying the session id forward', () => {
    const state: MapState = { sessionId: 'abc' }
    const events = mapMessage({ type: 'result', subtype: 'success', duration_ms: 42 }, state)

    expect(events).toEqual([{ type: 'done', sessionId: 'abc', durationMs: 42 }])
  })

  test('maps an errored result to a client-owned error, not the agent prose', () => {
    const events = mapMessage({ type: 'result', is_error: true }, fresh())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'cli_failed' })
  })

  test('an unrecognised message type is a no-op, not a crash', () => {
    expect(mapMessage({ type: 'some_future_event', payload: 1 }, fresh())).toEqual([])
    expect(mapMessage({ type: 'stream_event', event: { type: 'message_stop' } }, fresh())).toEqual(
      [],
    )
  })

  test('tolerates junk', () => {
    expect(mapMessage(null, fresh())).toEqual([])
    expect(mapMessage('nope', fresh())).toEqual([])
    expect(mapMessage({}, fresh())).toEqual([])
  })
})
