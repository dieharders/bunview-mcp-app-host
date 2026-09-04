/**
 * The distinction between a variable that is UNSET and one that is set to nothing.
 *
 * THE BUG THIS PINS. `tools` is the fence — the base set of built-in tools that exist at all
 * for a session — and the README documents `BUNVIEW_TOOLS=` as the way to close it completely.
 * It was read through `str`, which folds `''` into `undefined` so that an empty `BUNVIEW_MODEL`
 * means "no model set" rather than "a model named empty string". Correct for a scalar, wrong
 * here: the empty value fell through to `?? 'Read,Grep,Glob'` and quietly re-armed the three
 * tools the user had just asked to remove.
 *
 * The failure is silent in both directions. Nothing errors, the app starts, and the only way to
 * notice is to ask the agent to read a file and watch it succeed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SANDBOX_MODES, choice, list } from './config'

const KEY = 'BUNVIEW_TEST_LIST'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

test('set-but-empty means an empty list, not the fallback', () => {
  process.env[KEY] = ''

  // The assertion the fence rests on. `['Read','Grep','Glob']` here is the regression.
  expect(list(KEY, 'Read,Grep,Glob')).toEqual([])
})

test('unset means the fallback', () => {
  delete process.env[KEY]

  expect(list(KEY, 'Read,Grep,Glob')).toEqual(['Read', 'Grep', 'Glob'])
})

test('a list of only separators and spaces is still empty', () => {
  // `BUNVIEW_TOOLS=,` and `BUNVIEW_TOOLS=" "` are the same intent typed differently, and an
  // empty-string entry in `tools` would be a tool name the SDK cannot match anyway.
  process.env[KEY] = ' , , '

  expect(list(KEY, 'Read')).toEqual([])
})

test('entries are trimmed, so a readable value is not a broken one', () => {
  process.env[KEY] = 'Read, Grep , Glob'

  expect(list(KEY, '')).toEqual(['Read', 'Grep', 'Glob'])
})

/**
 * `choice` is the other half of the same lesson, arrived at from the opposite direction.
 *
 * `sandbox_mode` was a hardcoded `read-only` in codex.ts. Correct as a posture and unreachable
 * as a value — and on Windows it is the difference between Codex being able to read a file and
 * not, because every read it does is a shell command and a sandboxed shell command does not run
 * there yet. A knob with a safe default fixes that; a knob that accepts anything would just move
 * the failure onto the Codex command line, where a bad `-c sandbox_mode="typo"` is a non-zero
 * exit with no JSON and an empty bubble in the UI.
 */
test('an unrecognised value falls back rather than reaching the command line', () => {
  process.env[KEY] = 'read_only'

  expect(choice(KEY, SANDBOX_MODES, 'read-only')).toBe('read-only')
})

test('a recognised value is taken as given', () => {
  process.env[KEY] = 'danger-full-access'

  expect(choice(KEY, SANDBOX_MODES, 'read-only')).toBe('danger-full-access')
})

test('unset, and set-but-empty, both mean the default posture', () => {
  // Unlike `list`, empty is NOT a meaningful value here: there is no "no sandbox at all" mode,
  // so `BUNVIEW_CODEX_SANDBOX=` must not be a way to send `sandbox_mode=""`.
  delete process.env[KEY]
  expect(choice(KEY, SANDBOX_MODES, 'read-only')).toBe('read-only')

  process.env[KEY] = ''
  expect(choice(KEY, SANDBOX_MODES, 'read-only')).toBe('read-only')
})
