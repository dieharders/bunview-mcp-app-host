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
import { getState } from './state'

// Must be installed before anything can spawn an agent. See proc.ts — without this, closing
// the window mid-answer leaves the agent running against the user's plan.
hookShutdown()

const server = Bun.serve({
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
    '/api/state': { GET: () => Response.json(getState()) },

    // Everything else is the bundled frontend. Bun scans this HTML for <script> and <link>
    // tags, runs its JS and CSS bundlers over them, and — under `bun build --compile` —
    // embeds the results in the executable.
    '/*': index,
  },
})

declare var self: Worker
self.postMessage({ type: 'ready', port: server.port })
