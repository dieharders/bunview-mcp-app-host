import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
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
    expect(screen.getByText(/no API key involved/i)).toBeDefined()
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
