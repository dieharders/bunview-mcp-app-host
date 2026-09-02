/**
 * Fetch a vendor binary and prove it is the one they published.
 *
 * Everything here is in-process on purpose. The vendors' own installers are shell scripts
 * (`install.sh` / `install.ps1`) doing exactly these steps, and shelling out to them drags in
 * PowerShell execution policy, missing `bash`, and a second place for the download to fail.
 * There is no `npm`, no Node, no shell, and no admin rights anywhere in this path.
 */
import { mkdir, rename, rm, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface DownloadSpec {
  url: string
  /** Lowercase hex SHA-256 the vendor published for this artifact. */
  sha256: string
  /** Expected byte count, for the progress bar. 0 when the vendor does not publish one. */
  size: number
  /** Absolute path to write. */
  dest: string
  /** Mark executable afterwards (POSIX only; the bit is meaningless on Windows). */
  executable?: boolean
}

export type Progress = (received: number, total: number) => void

export class ChecksumError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`checksum mismatch: expected ${expected}, got ${actual}`)
    this.name = 'ChecksumError'
  }
}

/**
 * Download, verify, then move into place.
 *
 * The staging file matters. A ~200 MB download that dies half way through must not leave a
 * truncated binary at the final path — the next launch would find it, spawn it, and fail in a
 * way that looks like a broken app rather than an interrupted download. Nothing is renamed
 * into place until the hash matches.
 */
export async function downloadVerified(
  spec: DownloadSpec,
  signal: AbortSignal,
  onProgress?: Progress,
): Promise<void> {
  await mkdir(dirname(spec.dest), { recursive: true })
  const staging = `${spec.dest}.partial`

  try {
    const res = await fetch(spec.url, { signal })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)

    const total = Number(res.headers.get('content-length')) || spec.size
    const hasher = new Bun.CryptoHasher('sha256')
    const sink = Bun.file(staging).writer()

    let received = 0
    // Hash while streaming rather than re-reading the file afterwards: these artifacts are
    // 200 MB+, and a second full pass over disk to compute what we already had in memory is
    // pure waste.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hasher.update(chunk)
      sink.write(chunk)
      received += chunk.byteLength
      onProgress?.(received, total)
    }
    await sink.end()

    const actual = hasher.digest('hex')
    if (actual.toLowerCase() !== spec.sha256.toLowerCase()) {
      throw new ChecksumError(spec.sha256, actual)
    }

    // Replace, not overwrite: on Windows a running executable is locked, so remove first and
    // accept that a rename can still fail if the old copy is in use.
    await rm(spec.dest, { force: true })
    await rename(staging, spec.dest)
    if (spec.executable && process.platform !== 'win32') await chmod(spec.dest, 0o755)
  } finally {
    await rm(staging, { force: true }).catch(() => {})
  }
}

/**
 * Unpack a .tar.gz into a directory using the system `tar`.
 *
 * Shelling out here rather than in the download path because tar is genuinely everywhere —
 * bsdtar has shipped in Windows since 10 build 17063, and it is standard on macOS and Linux —
 * and because writing a tar parser to save one well-known subprocess is a poor trade. The
 * archive has already been checksum-verified by the caller before this runs.
 */
export async function extractTarGz(archive: string, intoDir: string): Promise<void> {
  await mkdir(intoDir, { recursive: true })
  const tar = Bun.which('tar')
  if (!tar) throw new Error('`tar` was not found, so the package cannot be unpacked.')

  const proc = Bun.spawn([tar, '-xzf', archive, '-C', intoDir], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`tar exited with ${code}: ${stderr.slice(0, 400)}`)
}

export const humanBytes = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`

export { join }
