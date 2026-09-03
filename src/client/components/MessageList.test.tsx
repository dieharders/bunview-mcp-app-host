import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { ChatMessage } from '../hooks/useClaudeStream'

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  text: 'hello',
  tools: [],
  streaming: false,
  ...over,
})

describe('MessageList', () => {
  test('renders both roles', () => {
    render(
      <MessageList
        waiting={false}
        messages={[
          message({ id: 'a', role: 'user', text: 'ping' }),
          message({ id: 'b', role: 'assistant', text: 'pong' }),
        ]}
      />,
    )

    expect(screen.getByText('ping')).toBeDefined()
    expect(screen.getByText('pong')).toBeDefined()
  })

  test('shows an empty state before the first message', () => {
    render(<MessageList waiting={false} messages={[]} />)
    expect(screen.getByText(/Ask something/i)).toBeDefined()
  })

  test('offers a starter prompt per app tool, and fills rather than sends', () => {
    const picked = mock((_: string) => {})
    render(<MessageList waiting={false} messages={[]} onPickPrompt={picked} />)

    const hints = screen.getAllByRole('button')
    expect(hints.map((b) => b.textContent)).toEqual([
      'Set the status lineset_status',
      'Leave a note on screenadd_note',
      'Read the state backget_app_state',
    ])

    fireEvent.click(hints[0]!)
    expect(picked).toHaveBeenCalledTimes(1)
    expect(picked.mock.calls[0]![0]).toMatch(/status/i)
  })

  test('hides the starter prompts when the provider cannot reach the app’s tools', () => {
    render(<MessageList waiting={false} messages={[]} />)
    expect(screen.queryByRole('group', { name: /Starter prompts/i })).toBeNull()
  })

  test('shows no starter prompts once the conversation has started', () => {
    render(<MessageList waiting={false} messages={[message()]} onPickPrompt={() => {}} />)
    expect(screen.queryByRole('group', { name: /Starter prompts/i })).toBeNull()
  })

  test('shows the typing indicator while waiting, with no empty bubble behind it', () => {
    render(
      <MessageList
        waiting
        messages={[
          message({ id: 'a', role: 'user', text: 'ping' }),
          message({ id: 'b', role: 'assistant', text: '', streaming: true }),
        ]}
      />,
    )

    expect(screen.getByLabelText('Waiting for a response')).toBeDefined()
  })

  test('renders tool chips by name', () => {
    render(<MessageList waiting={false} messages={[message({ tools: ['Read', 'Glob'] })]} />)

    expect(screen.getByText('Read')).toBeDefined()
    expect(screen.getByText('Glob')).toBeDefined()
  })

  test('is a polite live region so a screen reader announces streamed text', () => {
    render(<MessageList waiting={false} messages={[message()]} />)
    expect(screen.getByLabelText('Conversation').getAttribute('aria-live')).toBe('polite')
  })
})
