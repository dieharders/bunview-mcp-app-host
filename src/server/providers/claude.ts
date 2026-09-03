/**
 * The Claude provider: one turn of conversation, as a stream of `AppEvent`s.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent } from '../../shared/events'
import { errorCopy } from '../../shared/events'
import { config } from '../config'
import { childEnv } from '../env'
import { getState, getVersion } from '../state'
import { buildOptions } from './claude-options'
import { CLAUDE_SPEC, discoverCli, isInstalled } from './discovery'
import { mapMessage, type MapState } from './claude-map'
import { track, untrack } from '../proc'
import type { Provider, ProviderAuth, StreamOptions } from './types'

/** Every message in this file is about Claude, so the provider is never in question. */
const copy = (code: Parameters<typeof errorCopy>[0]) => errorCopy(code, 'claude')

const discover = () => discoverCli(CLAUDE_SPEC, config.claudePath)

const AUTH_TIMEOUT_MS = 15_000
/** Keep the tail, not the transcript: a wedged process can produce a lot of stderr. */
const STDERR_TAIL_BYTES = 4096

// `discover` already satisfies ProviderDetection, so there is no mapping step. The hand-copy
// that used to sit here is what dropped `argv` when the field was added — it typechecked,
// because a field-by-field copy of a wider type is exactly what TypeScript cannot warn about.
const detect = discover

/** Shape of `claude auth status --json`. Narrowed field by field below — never spread. */
interface AuthStatusJson {
  loggedIn?: boolean
  authMethod?: string
  apiProvider?: string
  email?: string
  subscriptionType?: string
  /**
   * WHICH CREDENTIAL IS ACTUALLY BEING BILLED. The field this whole app turns on.
   *
   * `'ANTHROPIC_API_KEY'` (environment), `'apiKeyHelper'`, `'/login managed key'`, or
   * `'none'`/absent for an OAuth login. Crucially it is INDEPENDENT of the three fields
   * above: with a key exported, `auth status` still reports `loggedIn: true`,
   * `authMethod: 'claude.ai'` and `subscriptionType: 'max'` — the OAuth login is real and
   * still on file — while `apiKeySource` says the key is what requests will use.
   *
   * Verified against claude 2.1.x on 2026-09-03: the only difference between the two runs was
   * this field appearing. Reading the first three alone reports "Max" for a session billed
   * per token, which is the exact lie the badge exists to prevent.
   */
  apiKeySource?: string
}

/**
 * Turn one `auth status --json` payload into the app's auth report.
 *
 * Split out from the spawn so the decision that matters — which credential gets billed — can
 * be tested as the pure function it is, without stubbing a subprocess. Same reasoning as
 * `terminal.ts`: the command's shape is a string, so test it as one.
 */
export function readAuthStatus(raw: AuthStatusJson): ProviderAuth {
  if (!raw.loggedIn) {
    return { state: 'logged_out', plan: null, account: null, subscription: false }
  }

  // An API key does NOT change apiProvider or authMethod — see the note on `apiKeySource`.
  // All three have to agree before this claims the plan is what gets billed.
  const keySource = typeof raw.apiKeySource === 'string' ? raw.apiKeySource : null
  const billedToKey = keySource !== null && keySource !== 'none'

  return {
    state: 'ok',
    plan: typeof raw.subscriptionType === 'string' ? raw.subscriptionType : null,
    account: typeof raw.email === 'string' ? raw.email : null,
    // A first-party claude.ai credential is the subscription path — unless a key is sitting
    // in front of it, in which case the UI warns about per-token billing instead.
    subscription:
      raw.apiProvider === 'firstParty' && raw.authMethod === 'claude.ai' && !billedToKey,
  }
}

async function authStatus(): Promise<ProviderAuth> {
  const found = await discover()
  if (!isInstalled(found)) {
    return { state: 'cli_missing', plan: null, account: null, subscription: false }
  }

  try {
    // ARGV, not `path`. A Node-launcher entry point is `[node, cli.js]`, and spawning the
    // `.js` alone execs a script as an image — which reported the badge as "unknown" while
    // sign-in, which already read argv, worked fine.
    const proc = Bun.spawn([...found.argv, 'auth', 'status', '--json'], {
      // Same environment as the chat turn. If these differed, the badge could report "Max"
      // while every message was actually billed to an API key.
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })

    const timer = setTimeout(() => proc.kill(), AUTH_TIMEOUT_MS)
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)

    if (code !== 0) return { state: 'unknown', plan: null, account: null, subscription: false }

    return readAuthStatus(JSON.parse(stdout) as AuthStatusJson)
  } catch (err) {
    console.error('[claude] auth status failed:', err)
    return { state: 'unknown', plan: null, account: null, subscription: false }
  }
}

async function* stream(opts: StreamOptions, signal: AbortSignal): AsyncGenerator<AppEvent> {
  const found = await discover()
  // Both conditions: `argv` is the installed test, and `path` is what the SDK wants further
  // down — `pathToClaudeCodeExecutable` takes one string and there is no argv form of it.
  if (!isInstalled(found) || !found.path) {
    yield { type: 'error', code: 'cli_missing', message: copy('cli_missing') }
    return
  }

  const controller = new AbortController()
  track(controller)

  // The reason has to be recorded where it is known: aborting, the stall timer and the wall
  // timer all end the run identically (the iterator stops), so by the time we are past the
  // loop there is nothing left to distinguish them.
  let reason: 'aborted' | 'timeout' | null = null
  const stop = (why: 'aborted' | 'timeout') => {
    reason ??= why
    controller.abort()
  }

  let stderrTail = ''
  const onStderr = (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
  }

  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stop('timeout'), config.stallTimeoutMs)
  }

  const wallTimer = setTimeout(() => stop('timeout'), config.wallTimeoutMs)
  const onAbort = () => stop('aborted')
  signal.addEventListener('abort', onAbort, { once: true })
  armStall()

  const state: MapState = { sessionId: opts.sessionId }
  let stateVersion = getVersion()

  try {
    const options = buildOptions(opts, found.path, controller, onStderr)

    for await (const message of query({ prompt: opts.prompt, options })) {
      armStall()

      for (const event of mapMessage(message, state)) yield event

      // Sample the app state between messages rather than wiring an event bus through the
      // MCP tools: the tools mutate `../state` synchronously inside their handler, so by the
      // time the next agent message arrives the change is already visible here.
      const version = getVersion()
      if (version !== stateVersion) {
        stateVersion = version
        const snapshot = getState()
        yield { type: 'state', status: snapshot.status, notes: snapshot.notes }
      }
    }

    if (reason === 'aborted') {
      yield { type: 'error', code: 'aborted', message: copy('aborted') }
    } else if (reason === 'timeout') {
      yield { type: 'error', code: 'timeout', message: copy('timeout') }
    }
  } catch (err) {
    // An abort surfaces here as a thrown error rather than a clean end of iteration.
    if (reason === 'aborted') {
      yield { type: 'error', code: 'aborted', message: copy('aborted') }
      return
    }
    if (reason === 'timeout') {
      yield { type: 'error', code: 'timeout', message: copy('timeout') }
      return
    }

    // The cause goes to the log; fixed, client-owned copy goes to the wire.
    console.error('[claude] stream failed:', err, stderrTail ? `\nstderr: ${stderrTail}` : '')

    const notAuthed = /not (logged in|authenticated)|auth login|please log in/i.test(
      stderrTail + String(err),
    )
    yield notAuthed
      ? { type: 'error', code: 'not_authenticated', message: copy('not_authenticated') }
      : { type: 'error', code: 'cli_failed', message: copy('cli_failed') }
  } finally {
    // Runs on the normal path AND when the consumer abandons the `for await` — an abandoned
    // async generator has .return() called on it, which executes this block. That generator
    // semantic is why this file needs no "settled" latch to stop post-abort work.
    clearTimeout(wallTimer)
    if (stallTimer) clearTimeout(stallTimer)
    signal.removeEventListener('abort', onAbort)
    controller.abort() // idempotent; guarantees the child dies even on an early return
    untrack(controller)
  }
}

export const claudeProvider: Provider = {
  id: 'claude',
  label: 'Claude Code',
  detect,
  authStatus,
  stream,
}
