/**
 * The Codex provider — ChatGPT Plus/Pro/Business, via OpenAI's `codex` CLI.
 *
 * Same shape as the Claude provider, and deliberately built on the same `Provider` interface
 * so the browser cannot tell them apart. Two honest differences, both surfaced in the picker
 * rather than discovered by the user later:
 *
 *   * `codex exec --json` emits COMPLETED ITEMS, not token deltas. There is no equivalent of
 *     `--include-partial-messages`, so a reply arrives in one piece when the model finishes
 *     it. The UI's `waiting` phase carries that wait; nothing else changes.
 *   * BunView's OWN tools are not registered here. Codex's own tools are untouched — shell,
 *     file edits, web search and any MCP server the user has configured all work, and are
 *     mapped to tool chips below.
 *
 *     The reason ours are missing is the registration channel, not the tools. The Claude Agent
 *     SDK has a bidirectional control protocol over the same stdio stream it uses to drive the
 *     CLI: `createSdkMcpServer` registers a tool for that session only, and when the model
 *     calls it the CLI asks back up the stream and our handler runs in this process. Codex's
 *     `exec --json` is one-way — prompt in, JSONL out — with no channel to answer on.
 *
 *     It is still DOABLE, just not for free: Codex reads MCP servers from
 *     `~/.codex/config.toml`, and a `url` entry there uses streamable HTTP, so BunView could
 *     serve `POST /mcp` from the Bun server it already runs and keep the tools in-process
 *     after all. The costs are what stopped it: it writes to the user's GLOBAL config rather
 *     than being scoped to one session the way the SDK's registration is, it currently needs
 *     `experimental_use_rmcp_client = true`, and it means implementing the MCP wire protocol
 *     rather than calling a helper. That is a feature, not a line of config — so it is left
 *     undone and said out loud rather than faked.
 *
 * NOTE: this provider is written against OpenAI's published CLI reference and has NOT been
 * exercised against a real `codex` install on this machine. The event mapping below is
 * deliberately tolerant — several plausible field names are accepted — because an unverified
 * schema should degrade to "no event" rather than to a crash.
 */
import type { AppEvent } from '../../shared/events'
import { errorCopy } from '../../shared/events'
import { config } from '../config'
import { childEnv } from '../env'
import { CODEX_SPEC, discoverCli, isInstalled } from './discovery'
import { readLines } from './ndjson'
import { track, untrack } from '../proc'
import type { Provider, ProviderAuth, StreamOptions } from './types'

/** Every message in this file is about Codex, so the provider is never in question. */
const copy = (code: Parameters<typeof errorCopy>[0]) => errorCopy(code, 'codex')

const AUTH_TIMEOUT_MS = 15_000
const STDERR_TAIL_BYTES = 4096

const discover = () => discoverCli(CODEX_SPEC, config.codexPath)

// `discover` already satisfies ProviderDetection; see the same note in claude.ts.
const detect = discover

async function authStatus(): Promise<ProviderAuth> {
  const found = await discover()
  if (!isInstalled(found)) {
    return { state: 'cli_missing', plan: null, account: null, subscription: false }
  }

  try {
    const proc = Bun.spawn([...found.argv, 'login', 'status'], {
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })

    const timer = setTimeout(() => proc.kill(), AUTH_TIMEOUT_MS)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)

    const text = `${stdout}\n${stderr}`

    // `codex login status` has no --json mode, so this reads its prose. Kept to two coarse
    // questions — signed in at all, and with which credential — because anything finer would
    // be guessing at wording we do not control.
    if (code !== 0 || /not (logged in|authenticated)|run `?codex login/i.test(text)) {
      return { state: 'logged_out', plan: null, account: null, subscription: false }
    }

    const account = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null
    // An API key bills per token; a ChatGPT plan is the subscription this app is about.
    const apiKey = /api key/i.test(text)
    const plan = text.match(/\b(plus|pro|business|team|enterprise)\b/i)?.[1]?.toLowerCase() ?? null

    return { state: 'ok', plan, account, subscription: !apiKey }
  } catch (err) {
    console.error('[codex] login status failed:', err)
    return { state: 'unknown', plan: null, account: null, subscription: false }
  }
}

/** Only the fields we read. See the file header on why this is tolerant rather than exact. */
interface CodexLine {
  type?: string
  thread_id?: string
  session_id?: string
  item?: { type?: string; text?: string; command?: string; name?: string }
  error?: { message?: string } | string
  message?: string
}

function mapCodexLine(raw: string, state: { sessionId: string | null }): AppEvent[] {
  let msg: CodexLine
  try {
    msg = JSON.parse(raw) as CodexLine
  } catch {
    return []
  }

  if (msg.type === 'thread.started') {
    const id = msg.thread_id ?? msg.session_id
    if (typeof id === 'string') {
      state.sessionId = id
      return [{ type: 'session', sessionId: id }]
    }
    return []
  }

  if (msg.type === 'item.started' || msg.type === 'item.completed') {
    const item = msg.item
    if (!item) return []

    // The assistant's prose. Emitted once, complete — see the header.
    if (item.type === 'agent_message' && msg.type === 'item.completed' && item.text) {
      return [{ type: 'delta', text: item.text }]
    }

    if (item.type === 'reasoning' && msg.type === 'item.started') return [{ type: 'thinking' }]

    // Tool-ish items, announced by NAME only on start. The command string is deliberately not
    // forwarded: it is the same disclosure surface as a tool input.
    if (msg.type === 'item.started') {
      const toolName = TOOL_LABELS[item.type ?? '']
      if (toolName) return [{ type: 'tool', name: toolName }]
    }
    return []
  }

  if (msg.type === 'turn.completed') {
    return [{ type: 'done', sessionId: state.sessionId, durationMs: null }]
  }

  if (msg.type === 'turn.failed' || msg.type === 'error') {
    return [{ type: 'error', code: 'cli_failed', message: copy('cli_failed') }]
  }

  return []
}

const TOOL_LABELS: Record<string, string> = {
  command_execution: 'Shell',
  file_change: 'Edit',
  mcp_tool_call: 'MCP tool',
  web_search: 'WebSearch',
}

async function* stream(opts: StreamOptions, signal: AbortSignal): AsyncGenerator<AppEvent> {
  const found = await discover()
  if (!isInstalled(found)) {
    yield { type: 'error', code: 'cli_missing', message: copy('cli_missing') }
    return
  }

  const args = [...found.argv, 'exec', '--json', '--skip-git-repo-check']

  // Read-only sandbox, matching the Claude provider's posture. Codex defaults to read-only
  // already; saying so explicitly means a future default change cannot silently widen this.
  args.push('--sandbox', 'read-only')

  if (opts.model !== 'default') args.push('--model', opts.model)
  // Resume is a SUBCOMMAND here, not a flag: `codex exec resume <id> "<prompt>"`.
  if (opts.sessionId) args.splice(found.argv.length + 1, 0, 'resume', opts.sessionId)
  args.push(opts.prompt)

  const proc = Bun.spawn(args, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: config.cwd,
    env: childEnv(),
    windowsHide: true,
  })

  const controller = new AbortController()
  track(controller)

  let reason: 'aborted' | 'timeout' | null = null
  const stop = (why: 'aborted' | 'timeout') => {
    reason ??= why
    try {
      proc.kill()
    } catch {
      // Already gone.
    }
  }

  let stderrTail = ''
  const drainErr = (async () => {
    for await (const line of readLines(proc.stderr as ReadableStream<Uint8Array>)) {
      stderrTail = (stderrTail + line + '\n').slice(-STDERR_TAIL_BYTES)
    }
  })().catch(() => {})

  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stop('timeout'), config.stallTimeoutMs)
  }
  const wallTimer = setTimeout(() => stop('timeout'), config.wallTimeoutMs)
  const onAbort = () => stop('aborted')
  signal.addEventListener('abort', onAbort, { once: true })
  controller.signal.addEventListener('abort', onAbort, { once: true })
  armStall()

  const state = { sessionId: opts.sessionId }

  try {
    for await (const line of readLines(proc.stdout as ReadableStream<Uint8Array>)) {
      armStall()
      for (const event of mapCodexLine(line, state)) yield event
    }

    const code = await proc.exited
    if (reason === 'aborted') {
      yield { type: 'error', code: 'aborted', message: copy('aborted') }
    } else if (reason === 'timeout') {
      yield { type: 'error', code: 'timeout', message: copy('timeout') }
    } else if (code !== 0) {
      await drainErr
      console.error(`[codex] exit ${code}\n${stderrTail}`)
      const notAuthed = /not (logged in|authenticated)|codex login/i.test(stderrTail)
      yield notAuthed
        ? { type: 'error', code: 'not_authenticated', message: copy('not_authenticated') }
        : { type: 'error', code: 'cli_failed', message: copy('cli_failed') }
    }
  } finally {
    clearTimeout(wallTimer)
    if (stallTimer) clearTimeout(stallTimer)
    signal.removeEventListener('abort', onAbort)
    try {
      proc.kill()
    } catch {
      // Already gone.
    }
    untrack(controller)
  }
}

export const codexProvider: Provider = {
  id: 'codex',
  label: 'Codex',
  detect,
  authStatus,
  stream,
}
