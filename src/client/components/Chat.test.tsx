import { beforeEach, describe, expect, mock, test } from 'bun:test'
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

const chooseProvider = (id: string) => localStorage.setItem('bunview.provider', id)

beforeEach(() => localStorage.clear())

describe('Chat — provider gate', () => {
  test('shows the picker and probes NOTHING until a provider is chosen', async () => {
    const fetchSpy = mock(async () => Response.json({}))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    render(<Chat />)

    expect(screen.getByRole('heading', { name: /Connect an AI plan/i })).toBeDefined()
    expect(screen.getByText('Claude Code')).toBeDefined()
    expect(screen.getByText('Codex')).toBeDefined()

    // The point of the gate: spawning a vendor's CLI to read their account is work nobody
    // should do on a subscription the user has not said they want to use.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('states Codex’s limitations up front rather than after committing', () => {
    globalThis.fetch = mock(async () => Response.json({})) as unknown as typeof fetch
    render(<Chat />)

    expect(screen.getByText(/token by token/i)).toBeDefined()
  })

  test('a remembered choice skips the picker', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: 'me@example.com', plan: 'max', subscription: true })
    render(<Chat />)

    expect(screen.queryByRole('heading', { name: /Connect an AI plan/i })).toBeNull()
    await waitFor(() => expect(screen.getByText(/Claude Code max/i)).toBeDefined())
  })
})

describe('Chat — signed in', () => {
  test('renders the shell and enables the composer', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: 'me@example.com', plan: 'max', subscription: true })
    render(<Chat />)

    expect(screen.getByRole('heading', { name: 'BunView' })).toBeDefined()
    await waitFor(() => expect(screen.getByText(/me@example.com/)).toBeDefined())

    const box = screen.getByPlaceholderText(/Ask Claude Code anything/i) as HTMLTextAreaElement
    expect(box.disabled).toBe(false)
  })

  test('labels the badge with the chosen provider, not a hardcoded one', async () => {
    chooseProvider('codex')
    mockServer({ state: 'ok', account: null, plan: 'pro', subscription: true })
    render(<Chat />)

    await waitFor(() => expect(screen.getByText(/Codex pro/i)).toBeDefined())
  })

  test('warns when billing is by API key rather than the subscription', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: null, plan: null, subscription: false })
    render(<Chat />)

    await waitFor(() => expect(screen.getByText(/billed per token/i)).toBeDefined())
  })

  test('offers model and effort pickers, defaulting effort to low', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: null, plan: 'pro', subscription: true })
    render(<Chat />)

    await waitFor(() => expect(screen.getByLabelText('Model')).toBeDefined())

    // A scaffold should not burn a Max plan's quota to say hello.
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('low')
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('default')
  })
})

describe('Chat — setup', () => {
  test('offers Install when the CLI is missing, and lists where it looked', async () => {
    chooseProvider('claude')
    mockServer({
      state: 'cli_missing',
      searched: ['PATH (none)', '/home/me/.local/bin/claude'],
      unresolvedShim: null,
      canInstall: true,
    })
    render(<Chat />)

    await waitFor(() => expect(screen.getByText(/Searched 2 locations/i)).toBeDefined())
    expect(screen.getByText('/home/me/.local/bin/claude')).toBeDefined()
    expect(screen.getByRole('button', { name: /Install/i })).toBeDefined()

    // Consent needs to know whose binary it is and where it goes.
    expect(screen.getByText(/Anthropic’s own signed binary/)).toBeDefined()
    expect(screen.getByText(/not on your PATH/)).toBeDefined()

    const box = screen.getByPlaceholderText(/Sign in to/i) as HTMLTextAreaElement
    expect(box.disabled).toBe(true)
  })

  test('hides Install when the server says it cannot (no npm, or disabled)', async () => {
    chooseProvider('claude')
    mockServer({ state: 'cli_missing', searched: [], unresolvedShim: null, canInstall: false })
    render(<Chat />)

    await waitFor(() => expect(screen.getByText(/isn’t installed/i)).toBeDefined())
    expect(screen.queryByRole('button', { name: /Install/i })).toBeNull()
  })

  test('offers Sign in — not Install — when the CLI exists but is signed out', async () => {
    chooseProvider('claude')
    mockServer({ state: 'logged_out' })
    render(<Chat />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Sign in/i })).toBeDefined())
    // Installing something already installed would be the wrong offer.
    expect(screen.queryByRole('button', { name: /Install/i })).toBeNull()
  })
})
