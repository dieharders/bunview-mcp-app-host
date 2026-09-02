/**
 * Which build of a CLI this machine needs, and where to put it.
 *
 * Two naming schemes, because the vendors use different ones: Anthropic's manifest keys look
 * like `darwin-arm64` / `linux-x64-musl` / `win32-x64`, and OpenAI's release assets are named
 * by Rust target triple. Both are derived from the same three questions below.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Libc = 'glibc' | 'musl'

/**
 * Detect Rosetta.
 *
 * `process.arch` reports x64 for a process translated by Rosetta on Apple Silicon, which
 * would land the user with the slow Intel build on an ARM machine. `sysctl.proc_translated`
 * is the documented way to ask whether we are the translated one.
 */
function isRosetta(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    const out = Bun.spawnSync(['sysctl', '-n', 'sysctl.proc_translated'], { stderr: 'ignore' })
    return out.stdout.toString().trim() === '1'
  } catch {
    return false
  }
}

/**
 * Detect musl (Alpine and friends).
 *
 * A glibc build segfaults on musl rather than failing to start with a clear message, so this
 * is worth getting right. `process.report` is the cheap answer — it names the glibc runtime
 * version when there is one — with the filesystem as the fallback.
 */
function detectLibc(): Libc {
  if (process.platform !== 'linux') return 'glibc'
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
    if (report?.header?.glibcVersionRuntime) return 'glibc'
  } catch {
    // Fall through to the filesystem probe.
  }
  try {
    const out = Bun.spawnSync(['sh', '-c', 'ls /lib/libc.musl-*.so.1 2>/dev/null'], {
      stderr: 'ignore',
    })
    if (out.stdout.toString().trim()) return 'musl'
  } catch {
    // Assume glibc — the far more common case, and the one whose build also runs under
    // compatibility layers.
  }
  return 'glibc'
}

export function effectiveArch(): 'x64' | 'arm64' {
  if (isRosetta()) return 'arm64'
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

/** Anthropic's manifest key, e.g. `win32-x64`, `linux-x64-musl`. */
export function claudePlatformKey(): string {
  const arch = effectiveArch()
  if (process.platform === 'win32') return `win32-${arch}`
  if (process.platform === 'darwin') return `darwin-${arch}`
  const suffix = detectLibc() === 'musl' ? '-musl' : ''
  return `linux-${arch}${suffix}`
}

/** OpenAI's Rust target triple, e.g. `x86_64-pc-windows-msvc`. */
export function codexTargetTriple(): string {
  const arch = effectiveArch() === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  // OpenAI ships only musl Linux builds; they are statically linked and run on glibc too.
  return `${arch}-unknown-linux-musl`
}

/**
 * Where a managed install lives.
 *
 * The app's own data directory, NOT next to the executable and NOT on the user's PATH. Three
 * reasons: writing beside the executable would break the code signature on macOS (a bundle is
 * a sealed, read-only structure), Program Files needs admin, and touching PATH is a change to
 * the user's shell environment we have no business making for a chat window. Uninstalling is
 * deleting this directory.
 */
export function managedRoot(): string {
  const home = homedir()
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'BunView')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'BunView')
  }
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'BunView')
}

export const managedBinDir = (provider: string) => join(managedRoot(), 'bin', provider)
