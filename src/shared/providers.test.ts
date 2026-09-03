/**
 * The per-provider choice lists, checked for the properties the rest of the app assumes.
 *
 * These lists used to be one global set holding Claude's values, which the composer showed
 * whichever provider was selected — so a Codex user was offered `opus` as a model and five
 * Claude effort levels, one of which (`max`) Codex does not take and none of which the Codex
 * provider passed anywhere. Splitting them per provider fixes that; these tests are what stop
 * a future edit from reintroducing a list that is merely plausible.
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  PROVIDERS,
  PROVIDER_IDS,
  coerceChoice,
  coerceSettings,
  defaultSettings,
} from './events'

// A plain loop rather than `describe.each`, matching setup.test.ts: bun's `each` types want an
// array of tuples, and a readonly string list is not one.
for (const id of PROVIDER_IDS) {
  describe(id, () => {
    const info = PROVIDERS[id]

    test('offers the vendor default model first', () => {
      // Model line-ups move; the vendor's own default is the one entry that cannot go stale,
      // so it must always be reachable and it must be what the composer lands on.
      expect(info.models[0]).toBe(DEFAULT_MODEL)
    })

    test('accepts the shared default effort', () => {
      // One constant serves both providers, so every provider has to include it or a fresh
      // composer would open on a value that provider's CLI rejects.
      expect(info.efforts).toContain(DEFAULT_EFFORT)
    })

    test('lists no duplicates', () => {
      expect(new Set(info.models).size).toBe(info.models.length)
      expect(new Set(info.efforts).size).toBe(info.efforts.length)
    })

    test('every declared setting has a usable default', () => {
      for (const setting of info.settings) {
        expect(setting.values.length).toBeGreaterThan(0)
        expect(defaultSettings(id)[setting.id]).toBe(setting.values[0] as string)
      }
    })

    test('setting ids are unique, or one would shadow the other', () => {
      const ids = info.settings.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })
}

describe('the two providers really are different', () => {
  test('their model lists do not collapse into one', () => {
    // If this ever passes trivially, the split has been undone and the composer is back to
    // showing one vendor's models to the other.
    expect(PROVIDERS.claude.models).not.toEqual(PROVIDERS.codex.models)
    expect(PROVIDERS.codex.models).not.toContain('opus')
    expect(PROVIDERS.claude.models).not.toContain('gpt-5.6-terra')
  })

  test('effort levels differ where the vendors differ', () => {
    // Documented asymmetry: `minimal` is Codex-only, `max` is Claude-only. Getting this wrong
    // is invisible in the UI and only shows up as a rejected subprocess argument.
    expect(PROVIDERS.codex.efforts).toContain('minimal')
    expect(PROVIDERS.claude.efforts).not.toContain('minimal')
    expect(PROVIDERS.claude.efforts).toContain('max')
    expect(PROVIDERS.codex.efforts).not.toContain('max')
  })
})

describe('coercion is the server-side guard', () => {
  test("a stale client's model for the wrong vendor falls back", () => {
    // The actual attack-shape: a tab left open on Claude, switched to Codex, still posting
    // `opus`. It must never reach a `codex --model` argument.
    expect(coerceChoice(PROVIDERS.codex.models, 'opus', DEFAULT_MODEL)).toBe(DEFAULT_MODEL)
    expect(coerceChoice(PROVIDERS.claude.efforts, 'minimal', DEFAULT_EFFORT)).toBe(DEFAULT_EFFORT)
  })

  test('a valid choice passes through untouched', () => {
    expect(coerceChoice(PROVIDERS.codex.models, 'gpt-5.6-terra', DEFAULT_MODEL)).toBe(
      'gpt-5.6-terra',
    )
  })

  test('non-strings do not slip through', () => {
    for (const bad of [null, undefined, 42, {}, ['opus']]) {
      expect(coerceChoice(PROVIDERS.claude.models, bad, DEFAULT_MODEL)).toBe(DEFAULT_MODEL)
    }
  })

  test('undeclared setting keys are dropped, not forwarded', () => {
    const out = coerceSettings('claude', { thinking: 'off', sandbox: 'danger-full-access' })
    expect(out.thinking).toBe('off')
    // A key a provider never declared must not survive into its flag mapping.
    expect('sandbox' in out).toBe(false)
  })

  test('a bad value for a declared key falls back to that key’s default', () => {
    expect(coerceSettings('claude', { thinking: 'banana' }).thinking).toBe('adaptive')
  })

  test('missing settings are filled with defaults rather than left absent', () => {
    expect(coerceSettings('codex', undefined)).toEqual(defaultSettings('codex'))
  })
})
