/**
 * Sign-in hands the terminal the DISCOVERED argv, not the bare command name.
 *
 * The regression this pins: a managed install lands in the app's data directory, deliberately
 * off PATH, so a terminal given `codex login` opens on "'codex' is not recognized" for a CLI
 * that is sitting right there on disk. The install succeeds and sign-in is unreachable.
 *
 * Run against EVERY provider, not just the one that was reported. The bug only surfaced for
 * Codex because Claude happened to be installed by its own installer — which does put it on
 * PATH — and was already signed in, so the broken branch was never reached. Nothing about the
 * defect was Codex-specific: `managedBinaryPath('claude')` is off PATH in exactly the same way.
 *
 * These are HANDLER tests: which status comes back, what reaches the OS, what the failure copy
 * says. The shape of the command itself is terminal.test.ts's job, because that is a pure
 * string and does not need a stubbed spawn to check.
 *
 * Stubs go through `spyOn`, which `mock.restore()` undoes even when a test throws. An earlier
 * version assigned over `Bun.spawn` and the provider registry by hand and restored them in an
 * `afterEach` — process-global state that leaks into every later file in the run if anything
 * fails on the way to the restore.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { PROVIDER_IDS, loginCommand, type ProviderId } from '../shared/events'
import { PROVIDER_IMPLS } from './providers'
import { handleLogin } from './setup'
import { shQuote, winCommandLine } from './terminal'
import type { ProviderDetection } from './providers/types'

const IS_WIN = process.platform === 'win32'

afterEach(() => {
  mock.restore()
})

/** Run handleLogin with discovery and the OS both stubbed, capturing what would be spawned. */
async function login(provider: ProviderId, detection: ProviderDetection, exitCode = 0) {
  const calls: string[][] = []

  spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => {
    calls.push(argv)
    return { pid: 0, kill() {}, unref() {}, exited: Promise.resolve(exitCode) }
  }) as unknown as typeof Bun.spawn)

  // Linux picks whichever emulator is on PATH. Pin it so this suite means the same thing on
  // every machine instead of depending on what the runner happens to have installed.
  spyOn(Bun, 'which').mockImplementation(
    ((name: string) => `/usr/bin/${name}`) as unknown as typeof Bun.which,
  )

  spyOn(PROVIDER_IMPLS[provider], 'detect').mockImplementation(() => Promise.resolve(detection))

  const res = await handleLogin(
    new Request('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
  )

  return {
    res,
    body: (await res.json()) as { ok: boolean; message: string },
    calls,
    /** Everything handed to the OS, flattened. Only for "did this path reach the OS at all". */
    text: calls.flat().join(' '),
  }
}

const found = (argv: string[]): ProviderDetection => ({
  argv,
  searched: [],
  unresolvedShim: null,
})

for (const provider of PROVIDER_IDS) {
  /** A real managed path for this platform, spaces and all. */
  const managed = IS_WIN
    ? `C:\\Users\\Jane Doe\\AppData\\Local\\BunView\\bin\\${provider}\\bin\\${provider}.exe`
    : `/Users/jane/Library/Application Support/BunView/bin/${provider}/bin/${provider}`

  describe(provider, () => {
    test('spawns the discovered binary, not the bare name', async () => {
      const { res, body, calls, text } = await login(provider, found([managed]))

      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(text).toContain(managed)

      // The whole defect in one assertion. Checked against the argv ELEMENTS rather than the
      // flattened text: the real POSIX managed path ends `/bin/codex/bin/codex`, so joining it
      // to the next element spells the literal string `codex login` and a substring check
      // would fail against a perfectly correct implementation.
      expect(calls.flat()).not.toContain(loginCommand(provider))
      expect(calls.flat()).not.toContain(provider)
    })

    test('packages the command the way this platform’s shell will parse it', async () => {
      const { calls } = await login(provider, found([managed]))
      const loginArgv = [managed, ...(provider === 'claude' ? ['auth', 'login'] : ['login'])]

      if (IS_WIN) {
        // One argument holding the whole command line, wrapped for `cmd /s`. Passing the parts
        // separately is what let cmd's quote rules mangle them.
        expect(calls.flat()).toContain(winCommandLine(loginArgv))
      } else {
        // Embedded in an AppleScript literal or a `bash -lc` payload — either way the path is
        // single-quoted, so a space cannot split it.
        expect(calls.flat().join(' ')).toContain(shQuote(managed))
      }
    })

    test('keeps the interpreter for a Node-launcher entry point', async () => {
      const js = IS_WIN ? 'C:\\npm\\node_modules\\bin\\cli.js' : '/opt/npm/node_modules/bin/cli.js'
      const node = IS_WIN ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node'

      const { text } = await login(provider, found([node, js]))

      const nodeAt = text.indexOf(node)
      expect(nodeAt).toBeGreaterThanOrEqual(0)
      // node must come BEFORE the script, or the .js is being executed directly.
      expect(text.indexOf(js)).toBeGreaterThan(nodeAt)
    })

    test('signs in through an unresolved shim rather than giving up', async () => {
      const shim = 'C:\\npm\\cli.cmd'
      const { body, text } = await login(provider, {
        argv: [],
        searched: [],
        unresolvedShim: shim,
      })

      expect(body.ok).toBe(true)
      // Compared after this platform's own escaping rather than raw: the macOS branch doubles
      // every backslash on its way into an AppleScript string literal, so a raw comparison
      // passes on Windows and fails on macOS for a correct implementation.
      expect(text).toContain(IS_WIN ? shim : shim.replaceAll('\\', '\\\\'))
    })

    test('reports not installed rather than spawning when nothing was found', async () => {
      const { res, body, calls } = await login(provider, found([]))

      expect(res.status).toBe(412)
      expect(body.ok).toBe(false)
      expect(calls).toHaveLength(0)
    })

    test('advises the resolved command, not the bare one, when no window opens', async () => {
      // Exit code 1: the launcher ran but no terminal appeared — a denied Automation prompt on
      // macOS, a missing emulator on Linux. Forcing it is the only way this assertion runs at
      // all; guarding with `if (body.ok) return` made the test unconditionally vacuous.
      const { body } = await login(provider, found([managed]), 1)

      expect(body.ok).toBe(false)
      expect(body.message).toContain(managed)
      expect(body.message).not.toContain(`\`${loginCommand(provider)}\``)
    })
  })
}

test('rejects an unknown provider without spawning', async () => {
  const calls: string[][] = []
  spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => {
    calls.push(argv)
    return { pid: 0, kill() {}, unref() {}, exited: Promise.resolve(0) }
  }) as unknown as typeof Bun.spawn)

  const res = await handleLogin(
    new Request('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({ provider: 'gemini' }),
    }),
  )

  expect(res.status).toBe(400)
  expect(calls).toHaveLength(0)
})
