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
import { managedBinaryPath } from '../install'
import type { ProviderDetection } from './types'

export interface CliSpec {
  /** Command name as it appears on PATH. */
  binary: string
  /** npm package that provides it. */
  npmPackage: string
  /** Path segments from the package root to the real entry point. */
  packageBin: string[]
  /**
   * Per-platform npm packages that ship the real binary inside the package itself, and the
   * file to look for within one. Empty for a vendor that publishes no such package.
   *
   * This is the Agent SDK's own delivery mechanism: `@anthropic-ai/claude-agent-sdk` declares
   * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` as optional dependencies, and npm
   * installs exactly the one that matches. So in dev there is already a version-matched
   * `claude.exe` sitting in node_modules — no shim, no PATH, no download.
   */
  bundledPackages?: string[]
  bundledBin?: string

  /**
   * Where this app would put its own managed copy.
   *
   * Checked LAST, on purpose: a CLI the user installed themselves stays authoritative. Two
   * copies of these tools share state under `~/.claude` / `~/.codex`, and quietly preferring
   * ours over one they already configured is how a working setup starts behaving oddly.
   */
  managedPath?: string
}

/**
 * The binary the Agent SDK shipped for this exact platform, if it is on disk.
 *
 * Worth a rung of its own for two reasons. It is version-matched to the SDK doing the driving,
 * which the user's own `claude` is not. And it is a real PE/Mach-O image at a known path,
 * which sidesteps the entire npm-shim problem in the header above — in dev, the case that
 * produces `spawn ...\nodejs\claude ENOENT` never arises, because this is found first.
 *
 * Resolution is deliberately allowed to fail silently: inside a `bun build --compile`
 * executable there is no node_modules to resolve against, and that is the normal case for a
 * shipped build rather than an error. It falls through to the rungs below.
 */
function bundledCandidates(spec: CliSpec): string[] {
  if (!spec.bundledPackages?.length || !spec.bundledBin) return []

  const out: string[] = []
  for (const pkg of spec.bundledPackages) {
    try {
      // Resolve the package.json rather than the package root: a package with no `main` (which
      // these are — they ship a binary, not JS) does not resolve by bare name.
      const manifest = Bun.resolveSync(`${pkg}/package.json`, import.meta.dir)
      out.push(join(dirname(manifest), spec.bundledBin))
    } catch {
      // Not installed for this platform, or no node_modules at all. Both are expected.
    }
  }
  return out
}

/**
 * What discovery knows, which is the provider seam's `ProviderDetection` plus one field.
 *
 * Declared as an EXTENSION rather than a second interface with the same members. As twins the
 * two drifted silently — `argv` was added to one and hand-copied into the other by each
 * provider's `detect`, and the copy that dropped it still typechecked.
 */
export interface Discovery extends ProviderDetection {
  /**
   * The primary executable, for the one API that wants a single string: the Agent SDK's
   * `pathToClaudeCodeExecutable`. Null when not found.
   *
   * Kept OFF `ProviderDetection` so nothing else can reach for it. For a Node-launcher entry
   * point this is the `.js`, and spawning it alone execs a script as an image.
   */
  path: string | null
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
 *
 * The fallback is the bare name `node`, NOT `process.execPath`. In a compiled build
 * (`bun build --compile`) `process.execPath` is this app's own executable, and a Bun
 * single-file binary ignores a trailing script argument — so handing that argv to a terminal
 * opens a second copy of BunView instead of the CLI. A bare `node` fails honestly when it is
 * absent, and resolves correctly in the login shell of the terminal we hand it to, which is
 * exactly the environment `candidates()` below exists because this process does not have.
 */
function toArgv(target: string): string[] {
  if (!target.toLowerCase().endsWith('.js')) return [target]
  return [Bun.which('node') ?? 'node', target]
}

/**
 * The argv to spawn for a discovery result, or [] when there is nothing runnable.
 *
 * One predicate, because there were three: `!path`, `argv.length === 0`, and a locally
 * rebuilt argv-or-shim ternary, spread across both providers, install verification and
 * sign-in. They are not equivalent — a Node-launcher entry point has a `.js` `path` and a
 * two-element `argv` — so which one a new call site picked decided whether it worked.
 *
 * The shim is a last resort and only for a terminal. discovery's header rejects cmd.exe for a
 * chat turn because it re-parses the user's prompt and orphans the real process on cancel; a
 * sign-in passes no user text and is meant to outlive the request in its own window, so
 * neither objection applies there.
 */
export function spawnableArgv(d: ProviderDetection): string[] {
  if (d.argv.length > 0) return d.argv
  return d.unresolvedShim ? [d.unresolvedShim] : []
}

/** Whether anything runnable was found. */
export const isInstalled = (d: ProviderDetection): boolean => d.argv.length > 0

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
      out.push(
        join(appdata, 'npm', 'node_modules', ...spec.npmPackage.split('/'), ...spec.packageBin),
      )
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
    // Never memoise a rejection. This cache lives as long as the process, so one transient
    // failure would otherwise leave the CLI permanently undiscoverable — including to the
    // Retry the user presses to recover.
    void found.catch(() => cache.delete(key))
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
      // Shim resolution is a Windows npm concern. Without the platform guard a leftover
      // `…\codex.cmd` in this variable on macOS was reported as an `unresolvedShim`, and
      // sign-in then fed a batch file to the user's shell.
      const target =
        IS_WIN && SHIM_EXT.test(override) ? await resolveShim(override, spec) : override
      if (target) return { argv: toArgv(target), path: target, searched, unresolvedShim: null }
      return { ...NOT_FOUND, searched, unresolvedShim: override }
    }
    return { ...NOT_FOUND, searched }
  }

  // A shim we could not resolve is REMEMBERED, not returned. Returning here meant a dead
  // `%APPDATA%\npm\codex.cmd` masked every later rung: the user installed a managed copy,
  // discovery stopped at the dead shim again, and the banner reported the download missing
  // for a binary sitting on disk — an install loop with no exit. It is only worth reporting
  // once nothing better has been found.
  let unresolvedShim: string | null = null

  // 2. PATH. On Windows this is the shim, which is what resolveShim is for.
  const which = Bun.which(spec.binary)
  if (which) {
    searched.push(`PATH (${which})`)
    if (IS_WIN && SHIM_EXT.test(which)) {
      const target = await resolveShim(which, spec)
      // Deliberately NOT returning the shim as `argv` — see the header comment on why routing
      // a user-typed prompt through cmd.exe is not an acceptable degradation. Sign-in may
      // still fall back to it; a chat turn may not. See `spawnableArgv`.
      if (target) return { argv: toArgv(target), path: target, searched, unresolvedShim: null }
      unresolvedShim = which
    } else {
      return { argv: toArgv(which), path: which, searched, unresolvedShim: null }
    }
  }

  // 3. Well-known locations, for the GUI-launch case.
  // 4. Then the binary the SDK shipped for this platform — after the user's own install, so
  //    theirs stays authoritative, but before our downloaded copy, because it is version-
  //    matched to the SDK that will drive it.
  // 5. Then this app's own managed copy, last.
  const rungs = [...candidates(spec), ...bundledCandidates(spec)]
  if (spec.managedPath) rungs.push(spec.managedPath)

  for (const candidate of rungs) {
    searched.push(candidate)
    if (await exists(candidate)) {
      return { argv: toArgv(candidate), path: candidate, searched, unresolvedShim: null }
    }
  }

  return { ...NOT_FOUND, searched, unresolvedShim }
}

export const CLAUDE_SPEC: CliSpec = {
  binary: 'claude',
  npmPackage: '@anthropic-ai/claude-code',
  packageBin: ['bin', IS_WIN ? 'claude.exe' : 'claude'],
  // Both libc flavours are listed for Linux because `process.platform` is 'linux' either way
  // and nothing in this process can tell glibc from musl. Only one will ever be installed, so
  // trying both costs a failed resolve rather than a wrong answer.
  bundledPackages:
    process.platform === 'linux'
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
        ]
      : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`],
  bundledBin: IS_WIN ? 'claude.exe' : 'claude',
  managedPath: managedBinaryPath('claude'),
}

export const CODEX_SPEC: CliSpec = {
  binary: 'codex',
  npmPackage: '@openai/codex',
  packageBin: ['bin', 'codex.js'],
  managedPath: managedBinaryPath('codex'),
}
