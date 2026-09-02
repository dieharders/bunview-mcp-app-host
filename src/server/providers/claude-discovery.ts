/**
 * Find the Claude Code executable.
 *
 * WHY THIS IS NOT JUST `Bun.which('claude')`.
 *
 * On Windows, npm installs a bin as three shims — `claude.cmd`, `claude.ps1`, `claude` — none
 * of which is a PE image. `Bun.which` returns the `.cmd`, and `Bun.spawn` uses no shell, so
 * `CreateProcess` cannot execute it. Anything that makes it work routes through `cmd.exe`,
 * and that breaks three things at once:
 *
 *   * An extra process appears in the tree. Killing the child then kills `cmd.exe` while the
 *     real binary — now reparented — keeps generating tokens against the user's plan with
 *     nobody listening. Cancel silently stops cancelling.
 *   * `cmd.exe` re-parses the argument string. The shim body is `"...\claude.exe" %*`, and
 *     `%*` re-expands under cmd rules: a prompt containing `&`, `|`, `>`, `^`, `(`, `)` splits
 *     or redirects the command line, and `%USERPROFILE%` expands inside the user's text. A
 *     chat textarea becomes a command-injection surface.
 *   * A console window can flash, defeating the PE subsystem patch in build.ts.
 *
 * So: resolve the shim to the real `.exe` and hand that to the SDK. Array argv, no shell,
 * no quoting, and the process we spawn is the process we can kill.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Discovery {
  /** Absolute path to a spawnable executable, or null. */
  path: string | null
  /** Everything tried, in order. This list IS the "not found" UI. */
  searched: string[]
  /** Set when a Windows shim was found but the executable it points at was not. */
  unresolvedShim: string | null
}

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''
const SHIM_EXT = /\.(cmd|ps1|bat)$/i

const exists = (p: string) => Bun.file(p).exists()

/**
 * Map an npm Windows shim to the executable it launches.
 *
 * npm's layout is fixed: the shim sits at the root of the global prefix and the package sits
 * under `node_modules` beside it, so the target is
 *   dirname(shim)/node_modules/@anthropic-ai/claude-code/bin/claude.exe
 *
 * Reading the shim body is the belt to that braces. The `.cmd` carries the relative path
 * verbatim as `"%dp0%\node_modules\...\claude.exe"   %*`, so if npm ever changes its layout
 * we can still read where the binary went instead of guessing.
 */
async function resolveShim(shim: string): Promise<string | null> {
  const dir = dirname(shim)

  const conventional = join(
    dir,
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  )
  if (await exists(conventional)) return conventional

  try {
    const body = await Bun.file(shim).text()
    const match = body.match(/"%dp0%\\(.+?\.exe)"/i)
    if (match?.[1]) {
      const parsed = join(dir, match[1])
      if (await exists(parsed)) return parsed
    }
  } catch {
    // Unreadable shim — fall through and report it as unresolved.
  }

  return null
}

/**
 * Well-known install locations.
 *
 * This list exists because a GUI-launched app does not get the login shell's PATH. Launched
 * from Explorer, the Dock or a .desktop entry, the process inherits a minimal environment —
 * on macOS typically just /usr/bin:/bin:/usr/sbin:/sbin — so `Bun.which` finds nothing even
 * though `claude` works perfectly in the user's terminal. That is the single most common
 * "it works in dev but not in the built app" failure for this kind of app.
 */
function candidates(): string[] {
  const home = homedir()
  const out = [
    join(home, '.claude', 'local', `claude${EXE}`), // official local installer
    join(home, '.local', 'bin', `claude${EXE}`), // native installer default
  ]

  if (IS_WIN) {
    const appdata = process.env.APPDATA
    if (appdata) {
      out.push(
        join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      )
    }
  } else {
    out.push(
      '/opt/homebrew/bin/claude', // Apple Silicon homebrew
      '/usr/local/bin/claude', // Intel homebrew / manual install
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude', // npm global prefix
      '/usr/bin/claude',
    )
  }

  return out
}

let cached: Promise<Discovery> | null = null

/** Drop the memoised result. Exported for tests, and for a future "re-detect" button. */
export function resetDiscovery(): void {
  cached = null
}

export function discoverClaude(): Promise<Discovery> {
  cached ??= runDiscovery()
  return cached
}

async function runDiscovery(): Promise<Discovery> {
  const searched: string[] = []

  // 1. Explicit override.
  //
  // A wrong override is a HARD FAILURE, never a silent fallthrough to discovery. Someone who
  // set this variable had a reason, and quietly running a different binary than the one they
  // named is the worst available outcome — it looks like it worked.
  const override = process.env.BUNVIEW_CLAUDE_PATH
  if (override) {
    searched.push(`$BUNVIEW_CLAUDE_PATH (${override})`)
    if (await exists(override)) {
      const real = SHIM_EXT.test(override) ? await resolveShim(override) : override
      return { path: real, searched, unresolvedShim: real ? null : override }
    }
    return { path: null, searched, unresolvedShim: null }
  }

  // 2. PATH. On Windows this is the shim, which is what resolveShim is for.
  const which = Bun.which('claude')
  if (which) {
    searched.push(`PATH (${which})`)
    if (SHIM_EXT.test(which)) {
      const real = await resolveShim(which)
      if (real) return { path: real, searched, unresolvedShim: null }
      // Deliberately NOT falling back to spawning the shim — see the header comment for why
      // routing a user-typed prompt through cmd.exe is not an acceptable degradation.
      return { path: null, searched, unresolvedShim: which }
    }
    return { path: which, searched, unresolvedShim: null }
  }

  // 3. Well-known locations, for the GUI-launch case.
  for (const candidate of candidates()) {
    searched.push(candidate)
    if (await exists(candidate)) return { path: candidate, searched, unresolvedShim: null }
  }

  return { path: null, searched, unresolvedShim: null }
}
