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
    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('aria-label')).toMatch(/Claude Code/i),
    )
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

    // Intent is the hardcoded-vendor guard, not the exact phrasing: assert the chosen
    // provider's label reaches the badge and the other vendor's never does.
    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('aria-label')).toMatch(/Codex/i),
    )
    expect(screen.getByRole('status').getAttribute('aria-label')).not.toMatch(/Claude/i)
  })

  test('warns when billing is by API key rather than the subscription', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: null, plan: null, subscription: false })
    render(<Chat />)

    await waitFor(() => expect(screen.getByText(/billed per token/i)).toBeDefined())
  })
})

/**
 * What is being billed, said out loud in both directions.
 *
 * The failure this guards is asymmetric and therefore easy to ship: the API-key path warns,
 * the subscription path used to just… not warn. "No warning" is indistinguishable from "not
 * checked yet" to anyone who has not read the source, so both states name the credential.
 */
describe('Chat — says which credential is in use', () => {
  /**
   * The badge's accessible name, which is the one place the whole claim exists as a single
   * string. The visible text is split across spans for styling, so asserting on it directly
   * is a matcher problem rather than a behaviour one.
   */
  const badge = () => screen.getByRole('status').getAttribute('aria-label') ?? ''

  test('names the plan when the subscription is what gets billed', async () => {
    chooseProvider('claude')
    mockServer({
      state: 'ok',
      account: 'me@example.com',
      plan: 'max',
      subscription: true,
      apiKeyOverride: false,
      credentialMode: 'auto',
    })
    render(<Chat />)

    await waitFor(() => expect(badge()).toMatch(/using your max plan/i))
    expect(badge()).toMatch(/me@example\.com/)
    expect(badge()).not.toMatch(/API key/i)
    expect(badge()).not.toMatch(/billed per token/i)
  })

  test('names the API key, and keeps the account while doing it', async () => {
    chooseProvider('claude')
    mockServer({
      state: 'ok',
      account: 'me@example.com',
      plan: 'max',
      subscription: false,
      apiKeyOverride: true,
      credentialMode: 'auto',
    })
    render(<Chat />)

    await waitFor(() => expect(badge()).toMatch(/using an API key/i))
    expect(badge()).toMatch(/billed per token/i)
    // Dropped on this path before. It is exactly when the user most needs it: the key and the
    // signed-in account can belong to different people.
    expect(badge()).toMatch(/me@example\.com/)
    // The account really does hold Max, but it is NOT what is paying — so the badge must not
    // present it as the live credential.
    expect(badge()).not.toMatch(/using your max plan/i)
  })

  test('the header never claims the subscription while an API key is winning', async () => {
    chooseProvider('claude')
    mockServer({
      state: 'ok',
      account: null,
      plan: 'max',
      subscription: false,
      apiKeyOverride: true,
      credentialMode: 'auto',
    })
    render(<Chat />)

    // The subtitle asserted "on your subscription" unconditionally, so the header and the
    // badge disagreed — one of them being wrong is worse than either being absent.
    await waitFor(() => expect(screen.getByText(/Claude Code on an API key/i)).toBeDefined())
    expect(screen.queryByText(/Claude Code on your subscription/i)).toBeNull()
  })
})

/**
 * Choosing between the plan and an API key.
 *
 * The app used to strip `ANTHROPIC_API_KEY` from every CLI it spawned. Anthropic's terms for
 * running Claude Code inside another product forbid the host removing an authentication method
 * built into the binary — the user's own API key being named as one — so the strip became a
 * mode the user picks, defaulting to `auto`. These pin that the choice is actually reachable,
 * and that it is hidden when it would be meaningless.
 */
describe('Chat — credential switch', () => {
  test('offers to switch to the plan when a key is present and winning', async () => {
    chooseProvider('claude')
    mockServer({
      state: 'ok',
      account: 'me@example.com',
      plan: 'max',
      subscription: false,
      apiKeyOverride: true,
      credentialMode: 'auto',
    })
    render(<Chat />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Use my plan/i })).toBeDefined())
    // The opposite offer would be nonsense in this state.
    expect(screen.queryByRole('button', { name: /Use API key/i })).toBeNull()
  })

  test('offers the way back, so the switch is never one-way', async () => {
    chooseProvider('claude')
    mockServer({
      state: 'ok',
      account: 'me@example.com',
      plan: 'max',
      subscription: true,
      apiKeyOverride: true,
      credentialMode: 'subscription',
    })
    render(<Chat />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Use API key/i })).toBeDefined())
    expect(screen.queryByRole('button', { name: /Use my plan/i })).toBeNull()
  })

  test('hides the switch entirely when there is no second credential', async () => {
    chooseProvider('claude')
    mockServer({
      state: 'ok',
      account: 'me@example.com',
      plan: 'max',
      subscription: true,
      apiKeyOverride: false,
      credentialMode: 'auto',
    })
    render(<Chat />)

    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('aria-label')).toMatch(/max plan/i),
    )
    // A toggle between one thing and itself implies the plan might not be what is billed,
    // when it certainly is.
    expect(screen.queryByRole('button', { name: /Use my plan/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Use API key/i })).toBeNull()
  })

  test('switching posts the new mode and re-probes rather than guessing the result', async () => {
    chooseProvider('claude')

    const calls: string[] = []
    let mode = 'auto'
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/api/credentials')) {
        mode = JSON.parse(String(init?.body)).mode as string
        return Response.json({ mode })
      }
      if (url.includes('/api/auth')) {
        return Response.json({
          state: 'ok',
          account: 'me@example.com',
          plan: 'max',
          // The server's answer changes with the mode, which is the point: the badge reports
          // what the CLI says, not what the click intended.
          subscription: mode === 'subscription',
          apiKeyOverride: true,
          credentialMode: mode,
        })
      }
      if (url.includes('/api/state')) return Response.json({ status: null, notes: [] })
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<Chat />)

    const button = await screen.findByRole('button', { name: /Use my plan/i })
    await act(async () => void fireEvent.click(button))

    expect(calls).toContain('POST /api/credentials')
    // Re-probed after the change, or the badge would still show the old billing.
    expect(calls.filter((c) => c.includes('/api/auth')).length).toBeGreaterThan(1)
    await waitFor(() => expect(screen.getByRole('button', { name: /Use API key/i })).toBeDefined())
  })
})

describe('Chat — composer', () => {
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

    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('aria-label')).toMatch(/Codex/i),
    )
    expect(screen.queryByRole('button', { name: /set_status/i })).toBeNull()
  })

  test('offers model and effort pickers, defaulting effort to low', async () => {
    chooseProvider('claude')
    mockServer({ state: 'ok', account: null, plan: 'pro', subscription: true })
    render(<Chat />)

    await waitFor(() => expect(screen.getByLabelText('Model')).toBeDefined())

    // A scaffold should not burn a Max plan's quota to say hello. There is no environment
    // variable for this — effort is per-message only; see the README's safety section.
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('low')
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('default')
  })
})

describe('Chat — new conversation', () => {
  /** One SSE body, framed the way the server writes it. */
  function sse(events: unknown[]): Response {
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
    return new Response(new TextEncoder().encode(body), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  test('New chat clears the app state the last conversation wrote', async () => {
    chooseProvider('claude')

    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/api/auth')) {
        return Response.json({ state: 'ok', account: null, plan: 'max', subscription: true })
      }
      if (url.includes('/api/chat')) {
        return sse([
          { type: 'session', sessionId: 's1' },
          { type: 'state', status: 'reading the codebase', notes: ['note one'] },
          { type: 'done', sessionId: 's1', durationMs: 1 },
        ])
      }
      if (url.includes('/api/state')) return Response.json({ status: null, notes: [] })
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<Chat />)

    const box = await screen.findByPlaceholderText(/Ask Claude Code anything/i)
    fireEvent.change(box, { target: { value: 'hello' } })
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Send/i })))

    // The agent's tool calls landed: status in the header and the panel, one note beside it.
    await waitFor(() =>
      expect(screen.getAllByText('reading the codebase').length).toBeGreaterThan(0),
    )
    expect(screen.getByText('note one')).toBeDefined()

    // This is the bug: the state is the server process's, not the session's, so dropping the
    // transcript used to leave the previous conversation's status on screen.
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /New chat/i })))

    expect(screen.queryByText('reading the codebase')).toBeNull()
    expect(screen.queryByText('note one')).toBeNull()
    expect(screen.getByText('— not set —')).toBeDefined()
    // Cleared on the server too, or a reload — and `get_app_state` — brings it straight back.
    expect(calls).toContain('DELETE /api/state')
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
