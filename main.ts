/**
 * Main thread: start the server in a Worker, then open a native window pointed at it.
 *
 * The ordering is not a style choice. `webview.run()` runs a blocking native event loop that
 * never returns until the user closes the window, so whichever thread calls it can do
 * nothing else for the life of the app. The window therefore gets the main thread and the
 * server gets a Worker — inverting this does not work.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'

/**
 * Hide the console window Windows allocates for a double-clicked executable.
 *
 * This is done at RUNTIME, on purpose. The obvious alternative — patching the PE subsystem
 * field from CONSOLE to WINDOWS at build time, the `editbin /SUBSYSTEM:WINDOWS` trick — also
 * removes the process's standard handles, and a double-clicked binary is then left with none
 * at all. Bun's Worker startup does not survive that: `new Worker(...)` below kills the
 * process outright, about a millisecond in, with no window, no output and no crash log. It
 * cannot be caught, because the process is gone before any handler runs.
 *
 * Keeping the CONSOLE subsystem keeps stdio valid; hiding the window afterwards gets the same
 * look. The cost is a brief console flash before this runs.
 *
 * Only hides a console this process OWNS. When the app is started from an existing terminal
 * (`bun run`, or a shell), that console belongs to the shell and is shared — hiding it would
 * take the user's own terminal window away. `GetConsoleProcessList` returning 1 means we are
 * the only process attached, which is exactly the double-click case.
 */
function hideOwnConsoleWindow(): void {
  if (process.platform !== 'win32') return

  try {
    const kernel32 = dlopen('kernel32.dll', {
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    })
    const user32 = dlopen('user32.dll', {
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    })

    const hwnd = kernel32.symbols.GetConsoleWindow()
    if (!hwnd) return // no console attached — nothing to hide

    const pids = new Uint32Array(2)
    if (kernel32.symbols.GetConsoleProcessList(ptr(pids), pids.length) !== 1) return

    user32.symbols.ShowWindow(hwnd, 0) // SW_HIDE
  } catch {
    // Cosmetic only. A visible console is far better than failing to start.
  }
}

const headless = process.argv.includes('--headless')

// The specifier MUST stay a plain string literal, and this file MUST stay at the repo root.
// Two separate constraints meet here:
//
//   * Bun discovers worker modules by STATIC ANALYSIS of this call. Wrapping the path in
//     `new URL(..., import.meta.url)` defeats it — the module is silently left out of the
//     compiled binary and the app dies at launch with ModuleNotFound.
//   * A plain specifier resolves against the entrypoint's directory, which in the compiled
//     binary is the bunfs root (the common ancestor of build.ts's `entrypoints`). Keeping
//     main.ts at the repo root makes that root the repo root, so `./src/server/worker.ts`
//     means the same thing in dev and inside the executable.
//
// Moving this file into src/ breaks the second one; making the path dynamic breaks the first.
const worker = new Worker('./src/server/worker.ts')

const serverReady = new Promise<number>((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error('Server failed to start within 10 seconds'))
  }, 10_000)

  worker.onmessage = (event) => {
    if (event.data?.type === 'ready') {
      clearTimeout(timeout)
      resolve(event.data.port as number)
    }
  }

  worker.onerror = (event) => {
    clearTimeout(timeout)
    reject(new Error(`Worker error: ${event.message}`))
  }
})

const port = await serverReady
// 127.0.0.1 rather than `localhost`: the server binds the IPv4 loopback, and on Windows
// `localhost` frequently resolves to ::1 first — which would refuse the connection.
const url = `http://127.0.0.1:${port}`

function printHeadless(reason?: string) {
  console.log(`\n  BunView is running at:\n`)
  console.log(`  → ${url}\n`)
  if (reason) console.log(`  (${reason})\n`)
}

if (headless) {
  printHeadless()
} else {
  try {
    // Imported dynamically inside the try so that a missing WebView2 runtime (Windows) or
    // WebKitGTK (Linux) degrades to "open this URL yourself" instead of crashing on startup.
    //
    // The specifier MUST stay a literal, exactly as for the Worker above: Bun's bundler
    // discovers it by static analysis, and hiding it behind a variable meant the package was
    // embedded in the compiled binary only when the minifier happened to inline the const.
    // tsc is kept away from the package's non-strict source by types/webview-bun.d.ts instead.
    const { Webview } = await import('webview-bun')

    const webview = new Webview()
    webview.title = 'BunView'
    webview.size = { width: 1100, height: 780, hint: 0 } // 0 = SizeHint.NONE (resizable)
    webview.navigate(url)

    // Only now, with a real window about to appear. If the webview had failed instead, we
    // fall through to printHeadless() below, and that message is only readable if the
    // console is still on screen — the branch exists precisely for machines where no native
    // window can be shown.
    hideOwnConsoleWindow()

    // Blocks until the window is closed.
    webview.run()

    // The window is gone. Terminating the worker does NOT reap processes the worker spawned,
    // which is why the worker installs its own exit sweep (src/server/proc.ts) — without it,
    // closing the window mid-answer leaves a claude process running against the user's plan.
    worker.terminate()
    process.exit(0)
  } catch {
    printHeadless('Native window unavailable — open the URL above in your browser')
  }
}
