/**
 * Sign-in hands the terminal the DISCOVERED path, not the bare command name.
 *
 * The regression this pins: a managed install lands in the app's data directory, deliberately
 * off PATH, so a terminal given `codex login` opens on "'codex' is not recognized" for a CLI
 * that is sitting right there on disk. The install succeeds and sign-in is unreachable.
 *
 * Run against EVERY provider, not just the one that was reported. The bug only surfaced for
 * Codex because Claude happened to be installed by its own installer — which does put it on
 * PATH — and was already signed in, so the broken branch was never reached. Nothing about the
 * defect was Codex-specific: `managedBinaryPath('claude')` is off PATH in exactly the same way,
 * and a provider-specific test would have gone on believing Claude was fine.
 *
 * Assertions read the FLATTENED command text rather than argv elements, because the three
 * platform branches package the same command differently: Windows passes it as separate
 * arguments to cmd, macOS embeds it in an AppleScript string literal, Linux in a `bash -lc`
 * payload. Matching elements would silently pass on the two platforms it never really checked.
 *
 * Linux is skipped because `spawnInTerminal` there depends on which terminal emulator happens
 * to be installed, which is not what this is testing.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from '../shared/events'
import { PROVIDER_IMPLS } from './providers'
import { handleLogin } from './setup'
import type { ProviderDetection } from './providers/types'

const IS_LINUX = process.platform === 'linux'

const realSpawn = Bun.spawn
const realDetect = new Map(PROVIDER_IDS.map((id) => [id, PROVIDER_IMPLS[id].detect]))

afterEach(() => {
  Object.assign(Bun, { spawn: realSpawn })
  for (const id of PROVIDER_IDS) PROVIDER_IMPLS[id].detect = realDetect.get(id)!
})

/** Run handleLogin with a stubbed discovery, capturing argv instead of opening a window. */
async function login(provider: ProviderId, detection: ProviderDetection) {
  const calls: string[][] = []
  Object.assign(Bun, {
    spawn: (argv: string[]) => {
      calls.push(argv)
      return { pid: 0, kill() {}, exited: Promise.resolve(0) }
    },
  })
  PROVIDER_IMPLS[provider].detect = () => Promise.resolve(detection)

  const res = await handleLogin(
    new Request('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
  )
  return {
    body: (await res.json()) as { ok: boolean; message: string },
    calls,
    /** Everything handed to the OS, as one string. See the header on why. */
    text: calls.flat().join(' '),
  }
}

const found = (argv: string[], path: string | null): ProviderDetection => ({
  argv,
  path,
  searched: [],
  unresolvedShim: null,
})

for (const provider of PROVIDER_IDS) {
  const info = PROVIDERS[provider]
  /** Managed-install shape, with a space in it — what naive command joining gets wrong. */
  const managed = `/Application Support/BunView/bin/${provider}/${provider}.exe`

  describe(provider, () => {
    test.skipIf(IS_LINUX)('spawns the discovered binary, not the bare name', async () => {
      const { body, text } = await login(provider, found([managed], managed))

      expect(body.ok).toBe(true)
      expect(text).toContain(managed)
      // The whole defect in one assertion: the bare command never reaches the terminal. It
      // survives the path containing the binary's name — `…/codex/codex.exe login` is not
      // `codex login` — which is what makes this catch the real bug rather than a near miss.
      expect(text).not.toContain(info.loginCommand)
    })

    test.skipIf(IS_LINUX)('passes the provider’s own login subcommand, in order', async () => {
      const { text } = await login(provider, found([managed], managed))

      let at = text.indexOf(managed)
      expect(at).toBeGreaterThanOrEqual(0)
      for (const arg of info.loginArgs) {
        const next = text.indexOf(arg, at)
        expect(next).toBeGreaterThan(at)
        at = next
      }
    })

    test.skipIf(IS_LINUX)('keeps a path with spaces intact', async () => {
      const { text } = await login(provider, found([managed], managed))

      // Neither split on the space nor pre-quoted by us: on Windows Bun quotes each argument on
      // its way to the OS, and a manually quoted string is exactly what cmd.exe mangles.
      expect(text).toContain(managed)
      expect(text).not.toContain(`"${managed}"`)
    })

    test.skipIf(IS_LINUX)('keeps the interpreter for a Node-launcher entry point', async () => {
      const js = `/opt/npm/node_modules/${info.npmPackage}/bin/${provider}.js`
      const { text } = await login(provider, found(['/usr/bin/node', js], js))

      const nodeAt = text.indexOf('/usr/bin/node')
      expect(nodeAt).toBeGreaterThanOrEqual(0)
      // node must come BEFORE the script, or the .js is being executed directly.
      expect(text.indexOf(js)).toBeGreaterThan(nodeAt)
    })

    test.skipIf(IS_LINUX)('signs in through an unresolved shim rather than giving up', async () => {
      const shim = `C:\\npm\\${provider}.cmd`
      const { body, text } = await login(provider, {
        argv: [],
        path: null,
        searched: [],
        unresolvedShim: shim,
      })

      expect(body.ok).toBe(true)
      expect(text).toContain(shim)
    })

    test('reports not installed rather than spawning when nothing was found', async () => {
      const { body, calls } = await login(provider, found([], null))

      expect(body.ok).toBe(false)
      expect(calls).toHaveLength(0)
    })

    test.skipIf(IS_LINUX)('advises the resolved command, not the bare one', async () => {
      const { body } = await login(provider, found([managed], managed))
      if (body.ok) return // A terminal opened; there is nothing to advise.

      // The "run it yourself" copy must not repeat the advice that just failed.
      expect(body.message).toContain(managed)
      expect(body.message).not.toContain(`\`${info.loginCommand}\``)
    })
  })
}
