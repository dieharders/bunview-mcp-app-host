/**
 * Make sure no agent process outlives the window.
 *
 * This is the most important lifecycle detail in the project, and it fails silently when it
 * is missing. The shutdown path is:
 *
 *     user closes the window
 *       -> webview.run() returns on the main thread
 *       -> worker.terminate(); process.exit(0)
 *
 * Neither `worker.terminate()` nor `process.exit()` reaps a GRANDCHILD. The agent binary was
 * spawned by the SDK from inside this worker, so without the sweep below it survives both,
 * keeps generating, and keeps consuming the user's plan — with no window left to show it in
 * and no obvious symptom beyond a 217 MB process in Task Manager.
 *
 * Aborting the controller is enough: the SDK owns the subprocess and kills it on abort. We
 * track controllers rather than processes so this file never needs to know how the provider
 * spawns anything.
 */
const live = new Set<AbortController>()

export function track(controller: AbortController): void {
  live.add(controller)
}

export function untrack(controller: AbortController): void {
  live.delete(controller)
}

/** Abort every in-flight turn. Safe to call more than once. */
export function sweep(): void {
  for (const controller of live) {
    try {
      controller.abort()
    } catch {
      // Already aborted, or the SDK tore it down first. Nothing to do either way.
    }
  }
  live.clear()
}

let hooked = false

export function hookShutdown(): void {
  if (hooked) return
  hooked = true

  // `exit` is the one that fires on the main thread's process.exit(0) after the window
  // closes; `beforeExit` covers a natural drain. Handlers must be synchronous — `exit` does
  // not await anything — which is why aborting (synchronous) is the right lever here.
  process.once('exit', sweep)
  process.once('beforeExit', sweep)
}
