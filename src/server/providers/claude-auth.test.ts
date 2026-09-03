/**
 * Which credential the badge says is being billed.
 *
 * THE BUG THESE PIN. `claude auth status --json` reports FOUR independent facts, and the app
 * used to read only three of them. With `ANTHROPIC_API_KEY` exported, a real machine returns:
 *
 *   { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
 *     subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY" }
 *
 * The OAuth login is genuine and still on file — so `loggedIn`, `authMethod` and `apiProvider`
 * all say "subscription" — while `apiKeySource` says the key is what requests will actually
 * use. Reading the first three alone renders a green "Claude Code max · you@example.com" over
 * a session billed per token, which is the precise lie the badge exists to prevent.
 *
 * The payloads below are copied from real runs of claude 2.1.x on 2026-09-03, differing only
 * in that one field, which is what made the defect findable at all.
 */
import { describe, expect, test } from 'bun:test'
import { readAuthStatus } from './claude'

/** A real signed-in Max account, no API key in the environment. */
const SUBSCRIPTION = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'me@example.com',
  subscriptionType: 'max',
} as const

describe('readAuthStatus', () => {
  test('reports the plan when the subscription is what gets billed', () => {
    const auth = readAuthStatus(SUBSCRIPTION)

    expect(auth.state).toBe('ok')
    expect(auth.subscription).toBe(true)
    expect(auth.plan).toBe('max')
    expect(auth.account).toBe('me@example.com')
  })

  test('an absent apiKeySource is a subscription, not an unknown', () => {
    // The signed-in payload genuinely OMITS the field rather than sending 'none'. Treating
    // absent as "a key might be present" would warn every correctly-configured user.
    expect('apiKeySource' in SUBSCRIPTION).toBe(false)
    expect(readAuthStatus(SUBSCRIPTION).subscription).toBe(true)
  })

  test('an environment API key means per-token billing, however good the login looks', () => {
    // The regression in one assertion: every other field still says "max subscription".
    const auth = readAuthStatus({ ...SUBSCRIPTION, apiKeySource: 'ANTHROPIC_API_KEY' })

    expect(auth.state).toBe('ok')
    expect(auth.subscription).toBe(false)
    // The plan is still REPORTED — the account really does have Max, and hiding that would be
    // its own kind of wrong. It is `subscription` that decides what the badge claims.
    expect(auth.plan).toBe('max')
  })

  test.each(['apiKeyHelper', '/login managed key'])(
    'treats %p as a key too, not just the env var',
    (source) => {
      // The field is an open set. Matching only 'ANTHROPIC_API_KEY' would let the other two
      // documented sources through as "subscription".
      expect(readAuthStatus({ ...SUBSCRIPTION, apiKeySource: source }).subscription).toBe(false)
    },
  )

  test("'none' is the CLI saying no key is in use", () => {
    expect(readAuthStatus({ ...SUBSCRIPTION, apiKeySource: 'none' }).subscription).toBe(true)
  })

  test('a third-party backend is not the subscription path', () => {
    // Bedrock/Vertex bill through the cloud provider. apiProvider is the field that moves.
    expect(readAuthStatus({ ...SUBSCRIPTION, apiProvider: 'bedrock' }).subscription).toBe(false)
  })

  test('signed out is signed out, and carries no account details', () => {
    const auth = readAuthStatus({ loggedIn: false })

    expect(auth.state).toBe('logged_out')
    expect(auth.subscription).toBe(false)
    expect(auth.plan).toBeNull()
    expect(auth.account).toBeNull()
  })

  test('survives a payload missing every optional field', () => {
    // Narrowed field by field rather than spread, so a CLI that drops a field degrades to
    // null instead of putting `undefined` on the wire.
    const auth = readAuthStatus({ loggedIn: true })

    expect(auth.state).toBe('ok')
    expect(auth.plan).toBeNull()
    expect(auth.account).toBeNull()
    expect(auth.subscription).toBe(false)
  })
})
