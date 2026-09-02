/**
 * Setup actions: install a missing CLI, and start a sign-in.
 *
 * These are the only two things in this app that reach outside its own process to change the
 * user's machine, so both are gated: the UI shows the exact command before running it, and
 * neither happens without an explicit click. `BUNVIEW_ALLOW_INSTALL=0` removes the install
 * path entirely for managed or offline deployments.
 */
import { PROVIDERS, type ProviderId, type SetupEvent } from '../shared/events'
import { config } from './config'
import { childEnv } from './env'
import { readLines } from './providers/ndjson'
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
 * The command that installs a provider's CLI.
 *
 * npm rather than bun: both packages publish per-platform binaries through npm's
 * `optionalDependencies`, and `npm install -g` is what puts the shim on PATH in the layout
 * that `discovery.ts` knows how to resolve.
 */
export function installCommand(provider: ProviderId): string[] | null {
  const npm = Bun.which('npm')
  if (!npm) return null
  return [npm, 'install', '-g', PROVIDERS[provider].npmPackage]
}

/** POST /api/install — run the install, streaming npm's output as it goes. */
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

  const cmd = installCommand(provider)
  if (!cmd) {
    return Response.json(
      {
        type: 'done',
        ok: false,
        message: 'npm was not found. Install Node.js, or install the CLI yourself.',
      } satisfies SetupEvent,
      { status: 412 },
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

      send({ type: 'log', line: `$ ${cmd.join(' ')}` })

      let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | null = null
      try {
        proc = Bun.spawn(cmd, {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: childEnv(),
          windowsHide: true,
        })

        const timer = setTimeout(() => proc?.kill(), INSTALL_TIMEOUT_MS)
        const onAbort = () => proc?.kill()
        ac.signal.addEventListener('abort', onAbort, { once: true })

        // npm writes progress to stderr and results to stdout; the user wants both, in order
        // of arrival, so they are drained concurrently rather than sequentially.
        const pump = async (s: ReadableStream<Uint8Array>) => {
          for await (const line of readLines(s)) send({ type: 'log', line })
        }
        await Promise.all([
          pump(proc.stdout as ReadableStream<Uint8Array>),
          pump(proc.stderr as ReadableStream<Uint8Array>),
        ])

        const code = await proc.exited
        clearTimeout(timer)
        ac.signal.removeEventListener('abort', onAbort)

        // The freshly installed binary is in a location discovery already cached a miss for.
        resetDiscovery()

        if (code === 0) {
          const found = await getProvider(provider).detect()
          send(
            found.path
              ? { type: 'done', ok: true, message: `Installed. Found it at ${found.path}` }
              : {
                  type: 'done',
                  ok: false,
                  message:
                    'Install finished but the command still is not on PATH. Try restarting BunView.',
                },
          )
        } else {
          send({
            type: 'done',
            ok: false,
            message: `npm exited with code ${code}. See the log above.`,
          })
        }
      } catch (err) {
        console.error('[setup] install failed:', err)
        send({ type: 'done', ok: false, message: 'Could not run npm. See the app log.' })
      } finally {
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
 */
export async function handleLogin(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as unknown
  const provider = providerFrom(body)
  if (!provider) return new Response('unknown provider', { status: 400 })

  const found = await getProvider(provider).detect()
  if (!found.path) {
    return Response.json(
      { type: 'done', ok: false, message: 'The CLI is not installed yet.' } satisfies SetupEvent,
      { status: 412 },
    )
  }

  const command = PROVIDERS[provider].loginCommand

  try {
    const spawned = spawnInTerminal(command)
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

/** Launch a command in whatever terminal this OS has. Returns false if none worked. */
function spawnInTerminal(command: string): boolean {
  const opts = { stdout: 'ignore', stderr: 'ignore', env: childEnv() } as const

  if (process.platform === 'win32') {
    // `start` is a cmd builtin, so it needs cmd. The empty "" is the window TITLE argument —
    // without it, `start` treats a quoted command as the title and opens an empty shell.
    // `/k` keeps the window open afterwards so the user can read the result.
    Bun.spawn(['cmd.exe', '/c', 'start', '""', 'cmd.exe', '/k', command], opts)
    return true
  }

  if (process.platform === 'darwin') {
    Bun.spawn(['osascript', '-e', `tell application "Terminal" to do script "${command}"`], opts)
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
    const args =
      term === 'gnome-terminal'
        ? ['--', 'bash', '-lc', `${command}; exec bash`]
        : ['-e', `bash -lc "${command}; exec bash"`]
    Bun.spawn([term, ...args], opts)
    return true
  }

  return false
}
