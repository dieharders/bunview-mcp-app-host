/**
 * What the spawned CLI is billed to.
 *
 * This is the file that decides whether a chat turn spends the user's Claude plan or their API
 * credits, so the tests are about the two directions of that switch and nothing else.
 *
 * `childEnv` once stripped `ANTHROPIC_API_KEY` unconditionally, and Anthropic's terms for
 * running Claude Code inside another product say the host may not remove, disable or restrict
 * an authentication method built into the binary — the user's own API key being explicitly
 * named as one. The strip is still the default, because being silently billed per token is the
 * footgun this app exists to close; what changed is that it is now BOUNDED.
 *
 * `auto passes the key through` below is a REQUIREMENT rather than an oversight: it is the
 * mode the header switches to, and the mode providers/claude.ts falls back to for a user whose
 * only credential is the key. If someone makes `auto` strip too, there is no longer any state
 * in which the key method works, and that test is what should stop them.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getCredentialMode, setCredentialMode } from './credentials'
import { childEnv, hadApiKeyOverride } from './env'

const KEY = 'ANTHROPIC_API_KEY'
const BASE = 'ANTHROPIC_BASE_URL'

let savedKey: string | undefined
let savedBase: string | undefined
let savedMode: ReturnType<typeof getCredentialMode>

beforeEach(() => {
  savedKey = process.env[KEY]
  savedBase = process.env[BASE]
  savedMode = getCredentialMode()
})

afterEach(() => {
  // Restore rather than delete: this process's real environment may legitimately have these,
  // and a test file that clears them leaks into every later file in the run.
  if (savedKey === undefined) delete process.env[KEY]
  else process.env[KEY] = savedKey
  if (savedBase === undefined) delete process.env[BASE]
  else process.env[BASE] = savedBase
  setCredentialMode(savedMode)
})

test('auto passes the key through — the app does not disable an auth method by default', () => {
  process.env[KEY] = 'sk-ant-test'
  setCredentialMode('auto')

  // The CLI applies its own precedence from here. Removing this expectation would restore the
  // exact behaviour the terms forbid.
  expect(childEnv()[KEY]).toBe('sk-ant-test')
})

test('subscription strips every override that would redirect billing', () => {
  process.env[KEY] = 'sk-ant-test'
  process.env[BASE] = 'https://example.invalid'
  setCredentialMode('subscription')

  const env = childEnv()
  expect(env[KEY]).toBeUndefined()
  expect(env[BASE]).toBeUndefined()
  expect(KEY in env).toBe(false)
})

test('stripping never takes the variables the binary needs to run with it', () => {
  process.env[KEY] = 'sk-ant-test'
  setCredentialMode('subscription')
  const env = childEnv()

  // The SDK's `env` option REPLACES the subprocess environment rather than merging, so an
  // over-eager strip leaves the CLI unable to find its own credentials — or to start at all.
  const pathVar = env.PATH ?? env.Path
  expect(pathVar).toBeTruthy()
  expect(env.HOME ?? env.USERPROFILE).toBeTruthy()
})

test('mutating the returned env does not mutate this process', () => {
  process.env[KEY] = 'sk-ant-test'
  setCredentialMode('subscription')
  childEnv()

  // A shallow copy is the whole defence here; returning process.env itself would have the
  // strip permanently unset the user's own variable.
  expect(process.env[KEY]).toBe('sk-ant-test')
})

test('the override flag reports the choice existing, not which side won', () => {
  process.env[KEY] = 'sk-ant-test'

  // True in BOTH modes: it drives whether the header offers a switch at all, and a switch
  // that vanished the moment you used it could never be undone.
  setCredentialMode('auto')
  expect(hadApiKeyOverride('claude')).toBe(true)
  setCredentialMode('subscription')
  expect(hadApiKeyOverride('claude')).toBe(true)

  // Never for Codex: none of these variables changes what the `codex` CLI does, so surfacing
  // one there would be a warning about nothing.
  expect(hadApiKeyOverride('codex')).toBe(false)
})

test('no override present means no choice to offer', () => {
  delete process.env[KEY]
  delete process.env[BASE]
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX

  expect(hadApiKeyOverride('claude')).toBe(false)
})
