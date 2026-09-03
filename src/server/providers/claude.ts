/**
 * The Claude provider: one turn of conversation, as a stream of `AppEvent`s.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent } from '../../shared/events'
import { ERROR_COPY } from '../../shared/events'
import { config } from '../config'
import { childEnv } from '../env'
import { getState, getVersion } from '../state'
import { buildOptions } from './claude-options'
import { CLAUDE_SPEC, discoverCli } from './discovery'
import { mapMessage, type MapState } from './claude-map'
import { track, untrack } from '../proc'
import type { Provider, ProviderAuth, ProviderDetection, StreamOptions } from './types'

const discover = () => discoverCli(CLAUDE_SPEC, config.claudePath)

const AUTH_TIMEOUT_MS = 15_000
/** Keep the tail, not the transcript: a wedged process can produce a lot of stderr. */
const STDERR_TAIL_BYTES = 4096

async function detect(): Promise<ProviderDetection> {
  const found = await discover()
  return {
    argv: found.argv,
    path: found.path,
    searched: found.searched,
    unresolvedShim: found.unresolvedShim,
  }
}

/** Shape of `claude auth status --json`. Narrowed field by field below — never spread. */
interface AuthStatusJson {
  loggedIn?: boolean
  authMethod?: string
  apiProvider?: string
  email?: string
  subscriptionType?: string
}

async function authStatus(): Promise<ProviderAuth> {
  const found = await discover()
  if (!found.path) {
    return { state: 'cli_missing', plan: null, account: null, subscription: false }
  }

  try {
    const proc = Bun.spawn([found.path, 'auth', 'status', '--json'], {
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

    const raw = JSON.parse(stdout) as AuthStatusJson
    if (!raw.loggedIn) {
      return { state: 'logged_out', plan: null, account: null, subscription: false }
    }

    return {
      state: 'ok',
      plan: typeof raw.subscriptionType === 'string' ? raw.subscriptionType : null,
      account: typeof raw.email === 'string' ? raw.email : null,
      // A first-party claude.ai credential is the subscription path. An API key reports a
      // different apiProvider, and the UI warns about per-token billing when it does.
      subscription: raw.apiProvider === 'firstParty' && raw.authMethod === 'claude.ai',
    }
  } catch (err) {
    console.error('[claude] auth status failed:', err)
    return { state: 'unknown', plan: null, account: null, subscription: false }
  }
}

async function* stream(opts: StreamOptions, signal: AbortSignal): AsyncGenerator<AppEvent> {
  const found = await discover()
  if (!found.path) {
    yield { type: 'error', code: 'cli_missing', message: ERROR_COPY.cli_missing }
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
      yield { type: 'error', code: 'aborted', message: ERROR_COPY.aborted }
    } else if (reason === 'timeout') {
      yield { type: 'error', code: 'timeout', message: ERROR_COPY.timeout }
    }
  } catch (err) {
    // An abort surfaces here as a thrown error rather than a clean end of iteration.
    if (reason === 'aborted') {
      yield { type: 'error', code: 'aborted', message: ERROR_COPY.aborted }
      return
    }
    if (reason === 'timeout') {
      yield { type: 'error', code: 'timeout', message: ERROR_COPY.timeout }
      return
    }

    // The cause goes to the log; fixed, client-owned copy goes to the wire.
    console.error('[claude] stream failed:', err, stderrTail ? `\nstderr: ${stderrTail}` : '')

    const notAuthed = /not (logged in|authenticated)|auth login|please log in/i.test(
      stderrTail + String(err),
    )
    yield notAuthed
      ? { type: 'error', code: 'not_authenticated', message: ERROR_COPY.not_authenticated }
      : { type: 'error', code: 'cli_failed', message: ERROR_COPY.cli_failed }
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
