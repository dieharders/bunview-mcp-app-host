/**
 * Setup actions: install a missing CLI, and start a sign-in.
 *
 * These are the only two things in this app that reach outside its own process to change the
 * user's machine, so both are gated: the UI names what will happen — the vendor, the version,
 * the size and the SHA-256 for a download; a terminal window for a sign-in — and neither
 * happens without an explicit click. Nothing auto-installs: Cursor shipped a silent
 * auto-install of its agent in 1.6.26 and reverted it in 1.7 after user pushback.
 * `BUNVIEW_ALLOW_INSTALL=0` removes the install path entirely for managed or offline builds.
 *
 * Note what the sign-in gate does NOT promise: the command the terminal receives is the
 * RESOLVED argv, which is deliberately not the bare `codex login` a user would recognise.
 * See `spawnableArgv` for why naming the pretty version would be naming the broken one.
 */
import { PROVIDERS, type ProviderId, type SetupEvent } from '../shared/events'
import { config } from './config'
import { ChecksumError } from './install/download'
import { installManaged } from './install'
import { resetDiscovery, spawnableArgv } from './providers/discovery'
import { getProvider } from './providers'
import { HEARTBEAT_MS, PING, SSE_HEADERS } from './sse'
import { displayCommand, openInTerminal } from './terminal'

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
          found.argv.length > 0
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

  // Held outside the try so the failure path can still name a command when it knows one.
  // Discovery itself can throw, and that is precisely when the user most needs somewhere to
  // go — so `detect()` belongs INSIDE the guard, not before it. Left outside, a rejected
  // discovery escaped the handler, Bun.serve answered with a non-JSON 500, and the client's
  // own catch printed the bare `codex login` this whole path exists to stop advising.
  let command: string | null = null

  try {
    const found = await getProvider(provider).detect()
    const argv = spawnableArgv(found)

    if (argv.length === 0) {
      return Response.json(
        { type: 'done', ok: false, message: 'The CLI is not installed yet.' } satisfies SetupEvent,
        { status: 412 },
      )
    }

    const loginArgv = [...argv, ...info.loginArgs]

    // The RESOLVED command, never `loginCommand`. This is the message that tells the user to
    // go type it themselves, so handing them the pretty bare name would reproduce the original
    // failure by hand — for a managed install it is the one command guaranteed not to work.
    command = displayCommand(loginArgv)

    if (!(await openInTerminal(loginArgv))) {
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
      message: command
        ? `Couldn’t start sign-in. Run \`${command}\` yourself, then press Retry.`
        : `Couldn’t start sign-in. Check that ${info.label} runs in a terminal, then press Retry.`,
    } satisfies SetupEvent)
  }
}
