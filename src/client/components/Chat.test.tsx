import { describe, expect, mock, test } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import { Chat } from './Chat'

/** Stand in for the server so the tree can mount without one. */
function mockServer(auth: unknown) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth')) return Response.json(auth)
    if (url.includes('/api/state')) return Response.json({ status: null, notes: [] })
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

describe('Chat', () => {
  test('renders the shell and enables the composer once signed in', async () => {
    mockServer({ state: 'ok', account: 'me@example.com', plan: 'max', subscription: true })
    render(<Chat />)

    expect(screen.getByRole('heading', { name: 'BunView' })).toBeDefined()

    await waitFor(() => {
      expect(screen.getByText(/Claude max/i)).toBeDefined()
    })
    expect(screen.getByText(/me@example.com/)).toBeDefined()

    const box = screen.getByPlaceholderText(/Ask Claude anything/i) as HTMLTextAreaElement
    expect(box.disabled).toBe(false)
  })

  test('warns when billing is by API key rather than the subscription', async () => {
    mockServer({ state: 'ok', account: null, plan: null, subscription: false })
    render(<Chat />)

    await waitFor(() => {
      expect(screen.getByText(/billed per token/i)).toBeDefined()
    })
  })

  test('disables the composer and explains how to fix it when signed out', async () => {
    mockServer({ state: 'logged_out' })
    render(<Chat />)

    await waitFor(() => {
      expect(screen.getByText(/claude auth login/i)).toBeDefined()
    })

    const box = screen.getByPlaceholderText(/Sign in to Claude Code/i) as HTMLTextAreaElement
    expect(box.disabled).toBe(true)
  })

  test('lists every path it searched when the CLI is missing', async () => {
    mockServer({
      state: 'cli_missing',
      searched: ['PATH (none)', '/home/me/.local/bin/claude'],
      unresolvedShim: null,
    })
    render(<Chat />)

    await waitFor(() => {
      expect(screen.getByText(/Searched 2 locations/i)).toBeDefined()
    })
    expect(screen.getByText('/home/me/.local/bin/claude')).toBeDefined()
  })

  test('offers model and effort pickers, defaulting effort to low', async () => {
    mockServer({ state: 'ok', account: null, plan: 'pro', subscription: true })
    render(<Chat />)

    await waitFor(() => {
      expect(screen.getByLabelText('Model')).toBeDefined()
    })

    const effort = screen.getByLabelText('Effort') as HTMLSelectElement
    // A scaffold should not burn a Max plan's quota to say hello.
    expect(effort.value).toBe('low')

    const model = screen.getByLabelText('Model') as HTMLSelectElement
    expect(model.value).toBe('default')
    expect([...model.options].map((o) => o.value)).toContain('opus')
  })
})
