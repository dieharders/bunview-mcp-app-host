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
import { list } from './config'

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
