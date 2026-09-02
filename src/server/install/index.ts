/**
 * Managed installs: fetch the vendor's own signed binary into this app's data directory.
 *
 * WHY NOT `npm install -g`, which this replaced:
 *
 *   * Anthropic deprecated it. Their README says so outright — "Installation via npm is
 *     deprecated. Use one of the recommended methods below." It is the only listed method
 *     that needs Node at all.
 *   * On Windows it cannot work from inside a GUI app. A process's environment block is
 *     fixed at launch and cannot be changed from outside, so after `npm -g` adds a directory
 *     to PATH, this app — and every child it spawns — still sees the old PATH. "Installed
 *     successfully, but I can't find it, please restart" is the EXPECTED outcome there.
 *   * It is the path with the documented failure surface: EACCES on global prefixes, the
 *     wrong-prefix bug when several Node versions are installed, corporate registries that
 *     mirror the wrapper package but not the eight platform packages, and `.cmd` shims that
 *     Node refuses to spawn at all since CVE-2024-27980.
 *
 * What we do instead is what the vendors' own installer scripts do — read a signed release
 * manifest, download the platform binary, verify its SHA-256 — minus the shell. The binaries
 * land Developer ID-signed and Apple-notarized (they are the vendor's, unmodified), and a
 * file fetched programmatically carries no `com.apple.quarantine`, so Gatekeeper does not
 * gate it. We add no signing obligations of our own.
 *
 * The install goes to this app's data directory and NOT onto PATH. That keeps a user's own
 * `claude` authoritative if they have one, and makes uninstalling a directory deletion.
 */
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { ProviderId } from '../../shared/events'
import { downloadVerified, extractTarGz, humanBytes } from './download'
import { claudePlatformKey, codexTargetTriple, managedBinDir } from './platform'

export type InstallLog = (line: string) => void

const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases'
const CODEX_CHANNEL = 'https://releases.openai.com/codex/channels/latest'

/** Where a managed copy of a provider's CLI would live, whether or not it exists yet. */
export function managedBinaryPath(provider: ProviderId): string {
  const dir = managedBinDir(provider)
  if (provider === 'claude') {
    return join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
  }
  // Codex ships a package tree, not a lone binary; its launcher sits under bin/.
  return join(dir, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
}

interface ClaudeManifest {
  version: string
  platforms: Record<string, { binary: string; checksum: string; size: number }>
}

async function installClaude(signal: AbortSignal, log: InstallLog): Promise<string> {
  // `stable` rather than `latest`: a scaffold should default to the build the vendor has
  // promoted, not the newest one they have published.
  const version = (await (await fetch(`${CLAUDE_RELEASES}/stable`, { signal })).text()).trim()
  log(`Claude Code ${version}`)

  const manifest = (await (
    await fetch(`${CLAUDE_RELEASES}/${version}/manifest.json`, { signal })
  ).json()) as ClaudeManifest

  const key = claudePlatformKey()
  const entry = manifest.platforms[key]
  if (!entry) {
    throw new Error(`Anthropic does not publish a build for ${key}.`)
  }

  const dest = managedBinaryPath('claude')
  log(`Platform ${key} · ${humanBytes(entry.size)}`)
  log(`SHA-256 ${entry.checksum}`)
  log(`Downloading to ${dest}`)

  let lastPct = -1
  await downloadVerified(
    {
      url: `${CLAUDE_RELEASES}/${version}/${key}/${entry.binary}`,
      sha256: entry.checksum,
      size: entry.size,
      dest,
      executable: true,
    },
    signal,
    (received, total) => {
      const pct = total ? Math.floor((received / total) * 100) : 0
      // Log every 10% rather than every chunk: at 200 MB this would otherwise be tens of
      // thousands of SSE frames for a progress bar.
      if (pct >= lastPct + 10) {
        lastPct = pct
        log(`  ${pct}% (${humanBytes(received)} of ${humanBytes(total)})`)
      }
    },
  )

  log('Checksum verified.')
  return dest
}

interface CodexAsset {
  name: string
  digest: string
  browser_download_url: string
}

async function installCodex(signal: AbortSignal, log: InstallLog): Promise<string> {
  const feed = (await (await fetch(CODEX_CHANNEL, { signal })).json()) as {
    tag_name?: string
    assets: CodexAsset[]
  }
  log(`Codex ${feed.tag_name ?? '(latest)'}`)

  const triple = codexTargetTriple()
  const wanted = `codex-package-${triple}.tar.gz`
  const asset = feed.assets.find((a) => a.name === wanted)
  if (!asset) throw new Error(`OpenAI does not publish a build for ${triple}.`)

  // The feed prefixes the algorithm, e.g. "sha256:abc…".
  const sha256 = asset.digest.replace(/^sha256:/, '')
  const dir = managedBinDir('codex')
  const archive = join(dir, wanted)

  log(`Platform ${triple}`)
  log(`SHA-256 ${sha256}`)
  log(`Downloading to ${dir}`)

  let lastPct = -1
  await downloadVerified(
    { url: asset.browser_download_url, sha256, size: 0, dest: archive },
    signal,
    (received, total) => {
      const pct = total ? Math.floor((received / total) * 100) : 0
      if (pct >= lastPct + 10) {
        lastPct = pct
        log(`  ${pct}% (${humanBytes(received)}${total ? ` of ${humanBytes(total)}` : ''})`)
      }
    },
  )

  log('Checksum verified. Unpacking…')
  // Unlike Claude Code, Codex is a tree — the launcher needs its sibling ripgrep, command
  // runner and sandbox helper — so the whole package is extracted rather than one file.
  await extractTarGz(archive, dir)
  await rm(archive, { force: true })

  return managedBinaryPath('codex')
}

/**
 * Install a provider's CLI into this app's data directory.
 *
 * Returns the path to the installed binary. Throws with a message safe to show the user —
 * every call site here either produced the message itself or wraps a checksum/HTTP failure.
 */
export async function installManaged(
  provider: ProviderId,
  signal: AbortSignal,
  log: InstallLog,
): Promise<string> {
  return provider === 'claude' ? installClaude(signal, log) : installCodex(signal, log)
}

/** Remove a managed copy. Uninstalling really is just deleting the directory. */
export async function removeManaged(provider: ProviderId): Promise<void> {
  await rm(managedBinDir(provider), { recursive: true, force: true })
}
