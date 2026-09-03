import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROVIDER_IDS } from '../../shared/events'
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

const PROVIDER_KEY = 'bunview.provider'
const chooseProvider = (id: string) => localStorage.setItem(PROVIDER_KEY, id)

beforeEach(() => localStorage.clear())

describe('Chat — provider gate', () => {
  test('shows the picker and probes NOTHING until a provider is chosen', async () => {
    const fetchSpy = mock(async () => Response.json({}))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    render(<Chat />)

    expect(screen.getByRole('heading', { name: /Connect your AI plan/i })).toBeDefined()
    expect(screen.getAllByRole('button')).toHaveLength(PROVIDER_IDS.length)

    // The point of the gate: spawning a vendor's CLI to read their account is work nobody
    // should do on a subscription the user has not said they want to use.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('each card commits to its own provider, and no other', async () => {
    // Deliberately structural: no assertion here reads any displayed text. Two earlier versions
    // of this test asserted copy and both went stale without anything regressing — first a
    // caveat quoted verbatim, then the chip's field after it switched from `npmPackage` to
    // `vendor`. Wording is the component's to change. What must hold is the wiring: every
    // registered provider is offered exactly once, and the nth card commits to the nth id.
    // Mis-wire that and the app spawns the wrong vendor's CLI against the wrong subscription —
    // a real bug that reads identically to a correct one on screen.
    for (const [index, id] of PROVIDER_IDS.entries()) {
      cleanup()
      localStorage.clear()
      // A real server stub, not an empty one: choosing releases the probes, and they have to
      // find well-formed responses waiting or the panel they feed crashes on the way up.
      mockServer({ state: 'ok', account: null, plan: 'pro', subscription: true })

      render(<Chat />)
      const cards = screen.getAllByRole('button')
      expect(cards).toHaveLength(PROVIDER_IDS.length)

      // Choosing unblocks the probes the gate was holding back, and those settle after the
      // click. Awaited here so they land inside `act` rather than against a tree the next
      // iteration has already unmounted.
      await act(async () => void fireEvent.click(cards[index]))
      expect(localStorage.getItem(PROVIDER_KEY)).toBe(id)
    }
  })

  test('a remembered choice skips the picker', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: 'me@example.com', plan: 'max', subscription: true })
    render(<Chat />)

    expect(screen.queryByRole('heading', { name: /Connect your AI plan/i })).toBeNull()
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

  test('a starter prompt fills the composer instead of sending it', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: null, plan: 'pro', subscription: true })
    render(<Chat />)

    const hint = await screen.findByRole('button', { name: /set_status/i })
    fireEvent.click(hint)

    const box = screen.getByPlaceholderText(/Ask Claude Code anything/i) as HTMLTextAreaElement
    expect(box.value).toMatch(/status/i)
    // Filling is not sending: nothing was posted to the agent.
    expect(screen.queryByLabelText('Waiting for a response')).toBeNull()
  })

  test('hides the starter prompts for a provider that cannot reach the app’s tools', async () => {
    chooseProvider('codex')
    mockServer({ state: 'ok', account: null, plan: 'pro', subscription: true })
    render(<Chat />)

    await waitFor(() => expect(screen.getByText(/Codex pro/i)).toBeDefined())
    expect(screen.queryByRole('button', { name: /set_status/i })).toBeNull()
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
