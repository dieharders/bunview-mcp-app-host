/**
 * Setup actions: install a missing CLI, and start a sign-in.
 *
 * These are the only two things in this app that reach outside its own process to change the
 * user's machine, so both are gated: the UI names exactly what will happen — the vendor, the
 * version, the size and the SHA-256 for a download; the exact command for a sign-in — and
 * neither happens without an explicit click. Nothing auto-installs: Cursor shipped a silent
 * auto-install of its agent in 1.6.26 and reverted it in 1.7 after user pushback.
 * `BUNVIEW_ALLOW_INSTALL=0` removes the install path entirely for managed or offline builds.
 */
import { PROVIDERS, type ProviderId, type SetupEvent } from '../shared/events'
import { config } from './config'
import { childEnv } from './env'
import { ChecksumError } from './install/download'
import { installManaged } from './install'
import { resetDiscovery } from './providers/discovery'
import { getProvider } from './providers'
import { HEARTBEAT_MS, PING, SSE_HEADERS } from './sse'

const INSTALL_TIMEOUT_MS = 300_000

const encoder = new TextEncoder()
const frame = (event: SetupEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

function providerFrom(body: unknown): ProviderId | null {
  const id = (body as { provider?: unknown } | null)?.provider
  return typeof id === 'string' && id in PROVIDERS ? (id as ProviderId) : null
}

/**
 * Whether a managed install is possible here.
 *
 * Always true in principle — it is an HTTPS download plus a SHA-256 check, with no npm, Node,
 * shell or admin rights involved — so this exists only so `BUNVIEW_ALLOW_INSTALL=0` and any
 * future precondition have one place to say no.
 */
export function canInstall(_provider: ProviderId): boolean {
  return config.allowInstall
}

/** POST /api/install — download the vendor's binary, streaming progress as it goes. */
export async function handleInstall(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as unknown
  const provider = providerFrom(body)
  if (!provider) return new Response('unknown provider', { status: 400 })

  if (!config.allowInstall) {
    return Response.json(
      {
        type: 'done',
        ok: false,
        message: 'Installing is disabled in this build.',
      } satisfies SetupEvent,
      { status: 403 },
    )
  }

  const ac = new AbortController()
  req.signal.addEventListener('abort', () => ac.abort(), { once: true })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(PING)
        } catch {
          // Closed.
        }
      }, HEARTBEAT_MS)
      ;(heartbeat as unknown as { unref?: () => void }).unref?.()

      const send = (event: SetupEvent) => {
        try {
          controller.enqueue(frame(event))
        } catch {
          // Client gone.
        }
      }

      const timer = setTimeout(() => ac.abort(), INSTALL_TIMEOUT_MS)

      try {
        const path = await installManaged(provider, ac.signal, (line) =>
          send({ type: 'log', line }),
        )

        // The binary now sits somewhere discovery already cached a miss for.
        resetDiscovery()

        const found = await getProvider(provider).detect()
        send(
          found.path
            ? { type: 'done', ok: true, message: `Installed to ${path}` }
            : {
                type: 'done',
                ok: false,
                message: 'The download finished but the binary could not be found afterwards.',
              },
        )
      } catch (err) {
        console.error('[setup] install failed:', err)

        // These messages are safe to show: they are either ours, or an HTTP/checksum failure
        // whose text we wrote. A checksum mismatch is called out specifically because it is
        // the one failure that might not be the user's network.
        const message =
          err instanceof ChecksumError
            ? 'The download did not match the checksum the vendor published, so it was discarded.'
            : ac.signal.aborted
              ? 'Install cancelled.'
              : `Install failed: ${err instanceof Error ? err.message : 'unknown error'}`
        send({ type: 'done', ok: false, message })
      } finally {
        clearTimeout(timer)
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }
    },

    cancel() {
      ac.abort()
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}

/**
 * Open the vendor's sign-in flow in a real terminal window.
 *
 * Not spawned headless with piped stdio, deliberately. Both vendors' login commands are
 * interactive: they open a browser, run a localhost callback listener, and may print a code to
 * confirm or ask a question. Driving that through pipes means reimplementing a flow we do not
 * control and cannot test against every version — and getting it subtly wrong strands the user
 * with no way to sign in at all.
 *
 * Handing the command to a terminal delegates to the vendor's own proven interactive path. The
 * banner then says "finish signing in, then press Retry", and `GET /api/auth` is the check.
 * A managed install lives in this app's data directory and deliberately not on PATH
 * (see install/platform.ts).
 */
export async function handleLogin(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as unknown
  const provider = providerFrom(body)
  if (!provider) return new Response('unknown provider', { status: 400 })

  const info = PROVIDERS[provider]
  const found = await getProvider(provider).detect()

  // An unresolved Windows shim is spawnable HERE even though `stream` refuses it. The header
  // on discovery.ts rejects cmd.exe for a turn because it re-parses the user's prompt and
  // orphans the real process on cancel; a sign-in passes no user text and is meant to outlive
  // this request in its own window, so neither objection applies. Better a working login
  // through the shim than "not installed" for a CLI the user can see.
  const argv =
    found.argv.length > 0 ? found.argv : found.unresolvedShim ? [found.unresolvedShim] : []

  if (argv.length === 0) {
    return Response.json(
      { type: 'done', ok: false, message: 'The CLI is not installed yet.' } satisfies SetupEvent,
      { status: 412 },
    )
  }

  const loginArgv = [...argv, ...info.loginArgs]

  // The RESOLVED command, not `info.loginCommand`. These two messages are the ones that tell
  // the user to go type it themselves. Quoting is for reading and pasting, so it only wraps what actually needs it.
  const command = loginArgv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')

  try {
    const spawned = spawnInTerminal(loginArgv)
    if (!spawned) {
      return Response.json({
        type: 'done',
        ok: false,
        message: `Couldn’t open a terminal. Run \`${command}\` yourself, then press Retry.`,
      } satisfies SetupEvent)
    }

    return Response.json({
      type: 'done',
      ok: true,
      message: `Finish signing in in the terminal window, then press Retry.`,
    } satisfies SetupEvent)
  } catch (err) {
    console.error('[setup] login failed:', err)
    return Response.json({
      type: 'done',
      ok: false,
      message: `Couldn’t start sign-in. Run \`${command}\` yourself, then press Retry.`,
    } satisfies SetupEvent)
  }
}

/**
 * Wrap one argv element for a POSIX shell.
 *
 * Single quotes rather than escaping, because inside them every character except `'` is
 * literal — no expansion, no globbing, no `$`. The discovered path is not user input, but it
 * routinely contains spaces (`~/Library/Application Support/…`).
 */
const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Launch an argv in whatever terminal this OS has. Returns false if none worked.
 *
 * Takes argv rather than a command string, and that is the whole trick on Windows. The obvious
 * version — join the parts, quote the path, hand cmd one string — cannot work: Bun escapes the
 * inner quotes backslash-style on the way to CreateProcess, cmd.exe does not treat `\"` as an
 * escape, and the window opens on a mangled path it says is not recognized. Passing the parts
 * as separate arguments lets Bun quote each one on its own, which is the form cmd does parse.
 */
function spawnInTerminal(argv: string[]): boolean {
  // cwd matters only cosmetically here — the login flow writes to ~/.codex, not to the working
  // directory — but a terminal that opens in System32 (where a GUI-launched app often starts)
  // reads like something went wrong. config.cwd is the same user-owned directory sessions run in.
  const opts = { stdout: 'ignore', stderr: 'ignore', env: childEnv(), cwd: config.cwd } as const

  if (process.platform === 'win32') {
    // `start` is a cmd builtin, so it needs cmd. The empty "" is the window TITLE argument —
    // without it, `start` treats a quoted command as the title and opens an empty shell.
    // `/k` keeps the window open afterwards so the user can read the result.
    Bun.spawn(['cmd.exe', '/c', 'start', '""', 'cmd.exe', '/k', ...argv], opts)
    return true
  }

  const command = argv.map(shQuote).join(' ')

  if (process.platform === 'darwin') {
    // Two escaping layers, not one: `command` is already shell-safe, and this embeds it in an
    // AppleScript string literal, where `\` and `"` are the two characters that would end it.
    const script = command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    Bun.spawn(['osascript', '-e', `tell application "Terminal" to do script "${script}"`], opts)
    Bun.spawn(['osascript', '-e', 'tell application "Terminal" to activate'], opts)
    return true
  }

  // Linux has no single answer; try the usual suspects in order of how likely they are to be
  // the session's actual terminal.
  for (const term of [
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'xterm',
  ]) {
    if (!Bun.which(term)) continue
    // `exec bash` keeps the window open after the flow finishes, matching /k on Windows.
    const payload = `${command}; exec bash`
    const args =
      term === 'gnome-terminal'
        ? ['--', 'bash', '-lc', payload]
        : // `-e` takes ONE string that the terminal re-splits, so this quotes a second time.
          ['-e', `bash -lc ${shQuote(payload)}`]
    Bun.spawn([term, ...args], opts)
    return true
  }

  return false
}
