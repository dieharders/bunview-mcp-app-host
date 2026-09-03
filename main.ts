/**
 * Main thread: start the server in a Worker, then open a native window pointed at it.
 *
 * The ordering is not a style choice. `webview.run()` runs a blocking native event loop that
 * never returns until the user closes the window, so whichever thread calls it can do
 * nothing else for the life of the app. The window therefore gets the main thread and the
 * server gets a Worker — inverting this does not work.
 */
import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi'

/**
 * The Win32 entry points this file needs, opened once and shared.
 *
 * `dlopen` on the same DLL twice yields two independent library objects and two symbol tables
 * for one library, which is what this file used to do: user32 opened in one function for
 * ShowWindow and again in another for SendMessageW. One bundle keeps a single handle per DLL,
 * and gives the next Win32 call somewhere obvious to go.
 *
 * Opened lazily, because dlopen resolves its symbols eagerly — doing this at module load would
 * throw on macOS and Linux, where none of these libraries exist. Nothing is ever closed: the
 * handles are wanted for the life of the process, and all three DLLs are already mapped into
 * every Windows process regardless.
 *
 * Both callers run inside a try/catch, so a failure here degrades to a visible console or a
 * default icon rather than a failed launch.
 */
let win32Libs: ReturnType<typeof openWin32> | null = null

function openWin32() {
  return {
    kernel32: dlopen('kernel32.dll', {
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    }),
    user32: dlopen('user32.dll', {
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      SendMessageW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.u64],
        returns: FFIType.u64,
      },
    }),
    shell32: dlopen('shell32.dll', {
      ExtractIconExW: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.u32,
      },
    }),
  }
}

function win32() {
  return (win32Libs ??= openWin32())
}

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
    const { kernel32, user32 } = win32()

    const hwnd = kernel32.symbols.GetConsoleWindow()
    if (!hwnd) return // no console attached — nothing to hide

    const pids = new Uint32Array(2)
    if (kernel32.symbols.GetConsoleProcessList(ptr(pids), pids.length) !== 1) return

    user32.symbols.ShowWindow(hwnd, 0) // SW_HIDE
  } catch {
    // Cosmetic only. A visible console is far better than failing to start.
  }
}

/**
 * Give the window the executable's own icon.
 *
 * Windows keeps two entirely separate icons, and setting one does nothing for the other:
 *
 *   * the FILE icon, a resource compiled into the .exe (build.ts passes it via `windows.icon`),
 *     which is what Explorer and a pinned shortcut display; and
 *   * the WINDOW icon, a per-window HICON, which is what the title bar and the taskbar button
 *     of a *running* window display.
 *
 * A window with no icon of its own gets a generic default — webview registers its window class
 * without one — so the app looks unbranded while running even though the file on disk looks
 * right. WM_SETICON is the fix, and it has to be sent once the window exists.
 *
 * ICON_SMALL drives the title bar, ICON_BIG the taskbar and Alt-Tab. They are two handles at
 * two sizes, not one handle sent twice — see the ExtractIconExW note below.
 *
 * Takes the webview rather than its handle. Reading `unsafeWindowHandle` is itself an FFI call
 * into the webview library, so as a caller's argument expression it sat OUTSIDE this function's
 * try/catch: a throw there would escape to the caller AFTER the native window had already been
 * created, leaving an unpainted window on screen and a process that reaches neither run() nor
 * exit().
 */
function setWindowIcon(webview: { readonly unsafeWindowHandle: Pointer | bigint | null }): void {
  if (process.platform !== 'win32') return

  try {
    const hwnd = webview.unsafeWindowHandle
    if (!hwnd) return

    const { shell32, user32 } = win32()

    // Index 0 is the first icon group in the binary, which is the one build.ts embedded.
    // Under `bun run` this resolves to bun.exe's icon instead — harmless in dev.
    const exePath = Buffer.from(`${process.execPath}\0`, 'utf16le')

    // ExtractIconExW, not ExtractIconW: the latter only ever returns the LARGE icon, sized to
    // SM_CXICON (32px). Sending that as ICON_SMALL made Windows downscale it to 16 for the
    // title bar rather than use the 16x16 entry assets/icon.ico carries — which is the size
    // the artwork was drawn to survive. ExtractIconExW fills both, each at its own metric.
    //
    // The out-parameters receive HICONs, so they are pointer-sized; windows-x64 is the only
    // Windows target.
    const large = new BigUint64Array(1)
    const small = new BigUint64Array(1)
    const extracted = shell32.symbols.ExtractIconExW(ptr(exePath), 0, ptr(large), ptr(small), 1)

    // The number of icons extracted, or 0xFFFFFFFF if the file could not be found; 0 means the
    // file holds none. Neither failure leaves a usable handle behind.
    if (extracted === 0 || extracted === 0xffff_ffff) return

    const WM_SETICON = 0x0080
    const ICON_SMALL = 0n
    const ICON_BIG = 1n

    // Either slot comes back null if the .ico lacks that size. A null would blank the window's
    // icon rather than set it, so skip instead of sending it.
    if (small[0]) user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small[0])
    if (large[0]) user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_BIG, large[0])

    // The HICONs are deliberately not destroyed: the window uses them for as long as it exists,
    // and the process owns them until it exits.
  } catch {
    // Cosmetic. A default icon is not worth failing a launch over.
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

    // After construction, so the HWND exists; before run(), which does not return until the
    // user closes the window.
    setWindowIcon(webview)

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
