/**
 * Find a vendor's CLI executable.
 *
 * WHY THIS IS NOT JUST `Bun.which(name)`.
 *
 * On Windows, npm installs a bin as three shims — `x.cmd`, `x.ps1`, `x` — none of which is a
 * PE image. `Bun.which` returns the `.cmd`, and `Bun.spawn` uses no shell, so `CreateProcess`
 * cannot execute it. Anything that makes it work routes through `cmd.exe`, and that breaks
 * three things at once:
 *
 *   * An extra process appears in the tree. Killing the child then kills `cmd.exe` while the
 *     real binary — now reparented — keeps generating tokens against the user's plan with
 *     nobody listening. Cancel silently stops cancelling.
 *   * `cmd.exe` re-parses the argument string. The shim body ends in `%*`, which re-expands
 *     under cmd rules: a prompt containing `&`, `|`, `>`, `^`, `(`, `)` splits or redirects
 *     the command line, and `%USERPROFILE%` expands inside the user's text. A chat textarea
 *     becomes a command-injection surface.
 *   * A console window can flash, defeating the PE subsystem patch in build.ts.
 *
 * So: resolve the shim to what it actually launches and spawn that directly.
 *
 * The two CLIs differ in what that target is, which is why `argv` exists rather than a bare
 * path. Claude Code's bin is a native `claude.exe`. Codex's bin is `bin/codex.js`, a Node
 * launcher that execs a platform binary — so it has to be run as `node codex.js`.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface CliSpec {
  /** Command name as it appears on PATH. */
  binary: string
  /** npm package that provides it. */
  npmPackage: string
  /** Path segments from the package root to the real entry point. */
  packageBin: string[]
}

export interface Discovery {
  /** Argv prefix to spawn, already resolved. Empty when nothing was found. */
  argv: string[]
  /** The primary executable, for APIs that want one path. Null when not found. */
  path: string | null
  /** Everything tried, in order. This list IS the "not found" UI. */
  searched: string[]
  /** Set when a Windows shim was found but the executable it points at was not. */
  unresolvedShim: string | null
}

const IS_WIN = process.platform === 'win32'
const SHIM_EXT = /\.(cmd|ps1|bat)$/i

const exists = (p: string) => Bun.file(p).exists()

const NOT_FOUND: Discovery = { argv: [], path: null, searched: [], unresolvedShim: null }

/**
 * Turn a resolved entry point into a spawnable argv.
 *
 * A `.js` entry point is a Node launcher, not an executable — running it directly either
 * fails or, worse on Windows, gets opened by whatever is registered for .js files.
 */
function toArgv(target: string): string[] {
  if (!target.toLowerCase().endsWith('.js')) return [target]
  const node = Bun.which('node') ?? process.execPath
  return [node, target]
}

/**
 * Map an npm Windows shim to the entry point it launches.
 *
 * npm's layout is fixed: the shim sits at the root of the global prefix and the package sits
 * under `node_modules` beside it. Reading the shim body is the belt to that braces — the
 * `.cmd` carries the relative path verbatim, so if npm ever changes its layout we can still
 * read where the entry point went instead of guessing.
 */
async function resolveShim(shim: string, spec: CliSpec): Promise<string | null> {
  const dir = dirname(shim)

  const conventional = join(dir, 'node_modules', ...spec.npmPackage.split('/'), ...spec.packageBin)
  if (await exists(conventional)) return conventional

  try {
    const body = await Bun.file(shim).text()
    const match = body.match(/"%dp0%\\(.+?\.(?:exe|js))"/i)
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
 * though the command works perfectly in the user's terminal. That is the single most common
 * "works in dev, broken in the built app" failure for this kind of app.
 */
function candidates(spec: CliSpec): string[] {
  const home = homedir()
  const exe = IS_WIN ? '.exe' : ''
  const out = [
    join(home, `.${spec.binary}`, 'local', `${spec.binary}${exe}`),
    join(home, '.local', 'bin', `${spec.binary}${exe}`),
  ]

  if (IS_WIN) {
    const appdata = process.env.APPDATA
    if (appdata) {
      out.push(join(appdata, 'npm', 'node_modules', ...spec.npmPackage.split('/'), ...spec.packageBin))
    }
  } else {
    const pkg = spec.npmPackage.split('/')
    out.push(
      `/opt/homebrew/bin/${spec.binary}`,
      `/usr/local/bin/${spec.binary}`,
      join('/usr/local/lib/node_modules', ...pkg, ...spec.packageBin),
      join('/opt/homebrew/lib/node_modules', ...pkg, ...spec.packageBin),
      `/usr/bin/${spec.binary}`,
    )
  }

  return out
}

const cache = new Map<string, Promise<Discovery>>()

/** Drop memoised results. Called after an install, and by tests. */
export function resetDiscovery(): void {
  cache.clear()
}

export function discoverCli(spec: CliSpec, override?: string): Promise<Discovery> {
  const key = `${spec.binary}:${override ?? ''}`
  let found = cache.get(key)
  if (!found) {
    found = runDiscovery(spec, override)
    cache.set(key, found)
  }
  return found
}

async function runDiscovery(spec: CliSpec, override?: string): Promise<Discovery> {
  const searched: string[] = []

  // 1. Explicit override.
  //
  // A wrong override is a HARD FAILURE, never a silent fallthrough to discovery. Someone who
  // set this had a reason, and quietly running a different binary than the one they named is
  // the worst available outcome — it looks like it worked.
  if (override) {
    searched.push(`override (${override})`)
    if (await exists(override)) {
      const target = SHIM_EXT.test(override) ? await resolveShim(override, spec) : override
      if (target) return { argv: toArgv(target), path: target, searched, unresolvedShim: null }
      return { ...NOT_FOUND, searched, unresolvedShim: override }
    }
    return { ...NOT_FOUND, searched }
  }

  // 2. PATH. On Windows this is the shim, which is what resolveShim is for.
  const which = Bun.which(spec.binary)
  if (which) {
    searched.push(`PATH (${which})`)
    if (SHIM_EXT.test(which)) {
      const target = await resolveShim(which, spec)
      // Deliberately NOT falling back to spawning the shim — see the header comment on why
      // routing a user-typed prompt through cmd.exe is not an acceptable degradation.
      if (target) return { argv: toArgv(target), path: target, searched, unresolvedShim: null }
      return { ...NOT_FOUND, searched, unresolvedShim: which }
    }
    return { argv: toArgv(which), path: which, searched, unresolvedShim: null }
  }

  // 3. Well-known locations, for the GUI-launch case.
  for (const candidate of candidates(spec)) {
    searched.push(candidate)
    if (await exists(candidate)) {
      return { argv: toArgv(candidate), path: candidate, searched, unresolvedShim: null }
    }
  }

  return { ...NOT_FOUND, searched }
}

export const CLAUDE_SPEC: CliSpec = {
  binary: 'claude',
  npmPackage: '@anthropic-ai/claude-code',
  packageBin: ['bin', IS_WIN ? 'claude.exe' : 'claude'],
}

export const CODEX_SPEC: CliSpec = {
  binary: 'codex',
  npmPackage: '@openai/codex',
  packageBin: ['bin', 'codex.js'],
}
