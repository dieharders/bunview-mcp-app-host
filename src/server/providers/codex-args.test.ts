/**
 * The Codex command line, which is where the "second reply never arrives" bug lived.
 *
 * THE BUG. `codex exec` and `codex exec resume` do not accept the same flags. `-s/--sandbox`
 * is an `exec` flag and is NOT on `exec resume`. The old builder pushed `--sandbox read-only`
 * unconditionally, so the first turn (plain `exec`) worked and every turn after it — which
 * resumes — hit a clap parse error:
 *
 *     error: unexpected argument '--sandbox' found
 *
 * A parse failure exits non-zero before a single JSON line is written, so the stream produced
 * no events and the user saw "Codex couldn't finish that request" with an empty bubble.
 *
 * Verified against codex-cli 0.153.0 on 2026-09-03, by running both forms: with `--sandbox`
 * the resume form prints the error above; without it, it parses and gets as far as looking up
 * the session id. That is why the invariant test below is the important one — it is not about
 * `--sandbox` specifically, but about the two forms never again diverging on flags.
 */
import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import { buildArgs } from './codex'
import type { StreamOptions } from './types'

const opts = (over: Partial<StreamOptions> = {}): StreamOptions => ({
  prompt: 'hello',
  sessionId: null,
  model: 'default',
  effort: 'medium',
  settings: { verbosity: 'medium', summary: 'auto' },
  ...over,
})

const ARGV = ['/opt/codex']
const build = (over: Partial<StreamOptions> = {}) => buildArgs(ARGV, opts(over))

/** Everything after the subcommand, which is the part the two forms must agree on. */
const flagsOf = (args: string[]) => args.slice(args.indexOf('--json'))

describe('codex buildArgs', () => {
  test('the first turn runs plain `exec`', () => {
    const args = build()
    expect(args.slice(0, 2)).toEqual(['/opt/codex', 'exec'])
    expect(args).not.toContain('resume')
  })

  test('a later turn resumes, with the id straight after the subcommand', () => {
    const args = build({ sessionId: 'SID' })
    // `resume` is a SUBCOMMAND and its id is positional, so both must sit before any flag or
    // clap reads the id as a value for whatever preceded it.
    expect(args.slice(0, 4)).toEqual(['/opt/codex', 'exec', 'resume', 'SID'])
  })

  test('NEVER passes --sandbox: it does not exist on `exec resume`', () => {
    // The regression, named directly.
    expect(build({ sessionId: 'SID' })).not.toContain('--sandbox')
    expect(build()).not.toContain('--sandbox')
  })

  test('resume and first-turn flags are IDENTICAL', () => {
    // The invariant that actually prevents this class of bug. Any flag valid on one form and
    // not the other reintroduces a turn that works followed by turns that do not — so the two
    // must differ ONLY by the `resume <id>` subcommand.
    expect(flagsOf(build({ sessionId: 'SID' }))).toEqual(flagsOf(build()))
  })

  test('states the sandbox explicitly, via config rather than the flag', () => {
    // The posture must survive the fix. `-c` is accepted by both forms; `--sandbox` is not.
    // The MODE now comes from config — Windows cannot run a sandboxed shell, so a hardcoded
    // value left those users with no way to make Codex read a file — but it is always SENT,
    // so a future change to the vendor's own default cannot silently widen this.
    for (const args of [build(), build({ sessionId: 'SID' })]) {
      expect(args).toContain(`sandbox_mode="${config.codexSandbox}"`)
    }
  })

  test('passes effort, which the provider used to accept and silently ignore', () => {
    expect(build({ effort: 'xhigh' })).toContain('model_reasoning_effort="xhigh"')
  })

  test('maps the declared settings to their vendor config keys', () => {
    const args = build({ settings: { verbosity: 'low', summary: 'concise' } })
    expect(args).toContain('model_verbosity="low"')
    expect(args).toContain('model_reasoning_summary="concise"')
  })

  test('TOML-quotes every config value', () => {
    // `-c` parses its value as TOML and only falls back to a raw string. An unquoted value
    // works by accident until one looks like a number or a bare keyword.
    for (const [i, arg] of build().entries()) {
      if (arg !== '-c') continue
      expect(build()[i + 1]).toMatch(/^[a-z_]+="[^"]*"$/)
    }
  })

  test('omits --model for the default, so the vendor picks', () => {
    expect(build()).not.toContain('--model')
    expect(build({ model: 'gpt-5.6-terra' })).toContain('gpt-5.6-terra')
  })

  test('the prompt is last, and never mistaken for a flag value', () => {
    for (const args of [build(), build({ sessionId: 'SID' })]) {
      expect(args[args.length - 1]).toBe('hello')
    }
  })

  test('a missing setting is omitted rather than sent empty', () => {
    // chat.ts fills defaults, so this is the stale-client path. An empty `-c key=""` would be
    // a value the vendor has to reject; sending nothing lets its own default stand.
    const args = buildArgs(ARGV, opts({ settings: {} }))
    expect(args.join(' ')).not.toContain('model_verbosity')
    expect(args.join(' ')).not.toContain('model_reasoning_summary')
  })
})
