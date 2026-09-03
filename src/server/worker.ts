/**
 * The HTTP server, running in a Worker.
 *
 * It lives off the main thread because `webview.run()` blocks its thread forever with a
 * native event loop — a `Bun.serve` on that same thread would register with an event loop
 * that never gets to run again, and every request would hang. The main thread owns the
 * window; this thread owns the server. They meet exactly once, at the ready handshake below.
 */
import index from '../client/index.html'
import { handleAuth } from './auth'
import { handleChat } from './chat'
import { config } from './config'
import { hookShutdown } from './proc'
import { handleInstall, handleLogin } from './setup'
import { getState, resetState } from './state'

// Must be installed before anything can spawn an agent. See proc.ts — without this, closing
// the window mid-answer leaves the agent running against the user's plan.
hookShutdown()

const server = Bun.serve({
  // Loopback ONLY. Bun's default is 0.0.0.0, and that default is wrong twice over here.
  //
  // Security: the only client is a webview on this machine. Bound to 0.0.0.0, every device on
  // the network can reach /api/chat — spending the user's Claude subscription — and /api/install,
  // which installs software. Neither endpoint authenticates, because the design assumes the
  // caller is the local window.
  //
  // Ergonomics: Windows Firewall prompts on the first launch of any program that listens on a
  // non-loopback address. Loopback traffic is never filtered, so binding here removes the popup
  // outright, with no firewall rule and no admin rights.
  hostname: '127.0.0.1',

  // 0 = let the OS pick a free port. The ready handshake already carries `server.port` back
  // to the main thread, so ephemeral ports cost nothing and remove a whole class of
  // "something else is already on 3000" failures.
  port: config.port,

  // Bun's default is 10s, which kills a long-lived SSE connection during the completely
  // normal quiet between "prompt sent" and "first token". The heartbeat in sse.ts is the
  // other half of this — a long thinking phase can exceed 120s too, and a ping resets the
  // timer indefinitely. Both are needed; neither alone is sufficient.
  idleTimeout: 120,

  routes: {
    '/api/chat': { POST: handleChat },
    '/api/auth': { GET: handleAuth },
    // DELETE is what "New chat" calls. The state lives in this process, not in the agent's
    // session, so starting a fresh conversation would otherwise leave the panel — and
    // `get_app_state` — showing what the PREVIOUS conversation wrote.
    '/api/state': {
      GET: () => Response.json(getState()),
      DELETE: () => Response.json(resetState()),
    },

    // The only two endpoints that change the user's machine or open an external flow. Both
    // are POST, and both are reached only from an explicit click that shows what will run.
    '/api/install': { POST: handleInstall },
    '/api/login': { POST: handleLogin },

    // Everything else is the bundled frontend. Bun scans this HTML for <script> and <link>
    // tags, runs its JS and CSS bundlers over them, and — under `bun build --compile` —
    // embeds the results in the executable.
    '/*': index,
  },
})

declare var self: Worker
self.postMessage({ type: 'ready', port: server.port })
