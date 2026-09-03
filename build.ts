/**
 * Packager: compile to a standalone executable, then make it look like a native app.
 *
 * Usage:
 *   bun run build.ts                    host platform -> ./bunview[.exe]
 *   bun run build.ts --all              all five targets -> dist/
 *   bun run build.ts --target=linux-x64 one target -> dist/
 *
 * Run `bun run build` rather than this directly — it generates the stylesheet first, which
 * is an INPUT to the bundle (see the precondition gate below).
 */
import { z } from 'zod'

import { buildIcns, largestPng, readIcoAsPngs } from './build-icons'

const TARGETS = [
  { name: 'darwin-arm64', target: 'bun-darwin-arm64', ext: '' },
  { name: 'darwin-x64', target: 'bun-darwin-x64', ext: '' },
  { name: 'windows-x64', target: 'bun-windows-x64', ext: '.exe' },
  { name: 'linux-x64', target: 'bun-linux-x64', ext: '' },
  { name: 'linux-arm64', target: 'bun-linux-arm64', ext: '' },
] as const

const APP_NAME = 'bunview'
const DISPLAY_NAME = 'BunView'
const BUNDLE_ID = 'com.bunview.app'
const PUBLISHER = 'BunView'

/**
 * Fixed, not `new Date().getFullYear()`. This string is compiled into the executable's
 * VERSIONINFO resource, so a wall-clock year would make the same commit produce different
 * bytes on either side of New Year's Eve: a downloaded release could no longer be checked
 * against a local rebuild, and re-running the release workflow on an old tag would silently
 * change the artifact. Bump it by hand.
 */
const COPYRIGHT_YEAR = '2026'

/**
 * Parsed, not asserted. `as { version: string; description: string }` claims a shape without
 * checking it, and npm treats both fields as optional: a missing `description` would reach the
 * VERSIONINFO resource as `undefined` while TypeScript still reported it as a string, and a
 * missing `version` would throw a raw TypeError out of WIN_VERSION below — at module load,
 * before any of this file's error paths could print something actionable.
 *
 * The version pattern is what makes WIN_VERSION safe: it guarantees a dot-separated numeric
 * prefix, so the four parts Windows ends up with are always numbers.
 */
const PackageSchema = z.object({
  version: z.string().regex(/^\d+(\.\d+)*([-+].*)?$/, 'must start with dot-separated numbers'),
  description: z.string().min(1),
})

const parsedPkg = PackageSchema.safeParse(await Bun.file('./package.json').json())
if (!parsedPkg.success) {
  console.error('✗ package.json is missing or malformed where the build reads it:')
  for (const issue of parsedPkg.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
  process.exit(1)
}
const pkg = parsedPkg.data

/**
 * Windows wants exactly four numeric parts; package.json carries SemVer, which can be shorter
 * (`1.0`) and can carry a suffix — a prerelease after `-`, build metadata after `+`. Dropping
 * both suffixes and padding to four turns `1.0.0-beta.1`, `0.1.0+abc1234` and `1.0` into
 * versions Windows accepts, rather than a string it rejects or shows verbatim in Properties.
 */
const WIN_VERSION = pkg.version
  .split(/[-+]/)[0]
  .split('.')
  .concat('0', '0', '0')
  .slice(0, 4)
  .join('.')

/**
 * The single icon artefact. Every platform's icon comes from it: Windows embeds it in the
 * executable's resources, and build-icons.ts re-encodes it into a .icns for the macOS bundle
 * and a .png for the Linux desktop entry.
 *
 * Resolved against this file rather than the CWD, so a build started from a subdirectory still
 * finds it. A missing file is a build error (requireIcon below) rather than a silent
 * downgrade — a release .exe wearing Bun's default console icon looks fine in CI and is only
 * noticed once somebody downloads it.
 */
const ICON_PATH = `${import.meta.dir}/assets/icon.ico`

/**
 * Metadata Windows shows in the file's Properties tab and in the SmartScreen / UAC prompt.
 * An unsigned binary with a blank publisher is exactly what a malicious download looks like,
 * so filling these in is worth the lines even before code signing.
 */
const windowsMetadata = {
  title: DISPLAY_NAME,
  publisher: PUBLISHER,
  version: WIN_VERSION,
  description: pkg.description,
  copyright: `© ${COPYRIGHT_YEAR} ${PUBLISHER}`,
  icon: ICON_PATH,
  // Pinned rather than left to Bun's default. `hideConsole: true` is the same GUI-subsystem
  // change this file used to make by hand, and it broke every double-click launch — see the
  // comment further down. Nothing in CI ever launches the binary, so a flipped default in a
  // future Bun release would ship silently; one explicit `false` makes that impossible.
  hideConsole: false,
}

const args = process.argv.slice(2)
const buildAll = args.includes('--all')
const targetArg = args.find((a) => a.startsWith('--target='))?.split('=')[1]

/**
 * Tailwind's output is an INPUT to this build, not a by-product of it: index.html links
 * `styles/generated.css`, and Bun's HTML bundler reads that file while compiling. Building
 * without it produces a binary that is either unstyled or fails to bundle at all — and
 * neither failure is visible until someone launches the exe. Fail loudly here instead.
 */
async function requireStylesheet() {
  const css = Bun.file('./src/client/styles/generated.css')
  if (!(await css.exists()) || css.size < 1024) {
    console.error('✗ src/client/styles/generated.css is missing or empty.')
    console.error('  Run `bun run build:css` first, or use `bun run build` which chains them.')
    process.exit(1)
  }
}

/** Same reasoning, for the other input nobody would notice was missing until download time. */
async function requireIcon() {
  if (!(await Bun.file(ICON_PATH).exists())) {
    console.error(`✗ ${ICON_PATH} is missing.`)
    console.error('  It is the source for the Windows, macOS and Linux icons alike. Restore it')
    console.error('  from git, or rebuild it from assets/icon.svg at 256, 128, 64, 48, 32, 16.')
    process.exit(1)
  }
}

async function buildTarget(outfile: string, target?: string) {
  // Only meaningful for a Windows output; harmless to omit everywhere else.
  const isWindows = target ? target.includes('windows') : process.platform === 'win32'

  const result = await Bun.build({
    // BOTH entrypoints. `main.ts` spawns `src/server/worker.ts` as a Worker, and a
    // worker module that is not an entrypoint does not make it into the compiled binary —
    // the app then dies at launch with a module-resolution error inside the Worker.
    entrypoints: ['./main.ts', './src/server/worker.ts'],
    compile: {
      outfile,
      ...(target ? { target: target as never } : {}),
      ...(isWindows ? { windows: windowsMetadata } : {}),
    },
    minify: true,
    sourcemap: 'linked',
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Build failed')
  }
}

/**
 * The Windows executable is deliberately left on the CONSOLE subsystem.
 *
 * This file used to patch the PE Subsystem field from CONSOLE (3) to WINDOWS (2) — the
 * `editbin /SUBSYSTEM:WINDOWS` trick, which is also what Bun's `hideConsole` does — to keep a
 * console window from appearing behind the app. That patch made the binary unusable when
 * double-clicked from Explorer: a GUI-subsystem process launched from the shell gets NO
 * standard handles, and Bun's Worker startup dies instantly when there are none. The app
 * exited about a millisecond in, showing no window and writing nothing anywhere. It only ever
 * "worked" when started from a terminal, a pipe, or any other parent that happened to supply
 * handles.
 *
 * The console window is hidden at runtime instead — see hideOwnConsoleWindow() in main.ts,
 * which also takes care not to hide a shell's console when the app is run from one.
 */

/** macOS needs a bundle plus a signature, or Gatekeeper refuses to launch the binary. */
async function makeMacApp(binaryPath: string, appDir: string) {
  const { mkdirSync, writeFileSync, chmodSync, copyFileSync, existsSync } = await import('node:fs')
  if (!existsSync(binaryPath)) return

  const contentsDir = `${appDir}/Contents`
  mkdirSync(`${contentsDir}/MacOS`, { recursive: true })
  mkdirSync(`${contentsDir}/Resources`, { recursive: true })

  copyFileSync(binaryPath, `${contentsDir}/MacOS/${APP_NAME}`)
  chmodSync(`${contentsDir}/MacOS/${APP_NAME}`, 0o755)

  // Finder and the Dock read the bundle's own icon and know nothing about the icon resource
  // compiled into the executable. Both halves are needed: the file in Resources, and the
  // CFBundleIconFile key naming it. Without them macOS shows the generic application icon.
  writeFileSync(
    `${contentsDir}/Resources/${APP_NAME}.icns`,
    buildIcns(await readIcoAsPngs(ICON_PATH)),
  )

  writeFileSync(
    `${contentsDir}/Info.plist`,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${DISPLAY_NAME}</string>
  <key>CFBundleDisplayName</key><string>${DISPLAY_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- REQUIRED for sign-in to work at all. Opening a terminal on macOS drives Terminal.app
       through an Apple Event, and since 10.14 an app without this key is refused with
       errAEEventNotPermitted (-1743) and NO consent prompt: osascript exits non-zero, no
       window appears, and the app has no way to tell. The string is what the user reads in
       the permission dialog, so it says which app and why.
       Note this only bites the shipped bundle — run from a terminal in development, the
       TERMINAL is the responsible process and it already holds the permission, which is why
       this was invisible for so long. -->
  <key>NSAppleEventsUsageDescription</key><string>${DISPLAY_NAME} opens a Terminal window so you can sign in to your CLI.</string>
</dict>
</plist>`,
  )

  // Ad-hoc signature (`-s -`). Enough to get past Gatekeeper locally; distributing to other
  // Macs would still need a Developer ID identity and notarization.
  const codesign = Bun.spawnSync(['codesign', '--force', '--deep', '-s', '-', appDir])
  if (codesign.exitCode === 0) console.log('  → Ad-hoc signed')
  else
    console.warn('  ⚠ codesign failed (Gatekeeper may block the app):', codesign.stderr.toString())

  Bun.spawnSync(['xattr', '-cr', appDir]) // strip the quarantine attribute
  console.log(`  → ${appDir}`)
}

async function makeLinuxDesktop(binaryPath: string, desktopPath: string, iconPath: string) {
  const { writeFileSync, existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  if (!existsSync(binaryPath)) return

  writeFileSync(iconPath, largestPng(await readIcoAsPngs(ICON_PATH)))
  console.log(`  → ${iconPath}`)

  // `Icon=` used to be the bare name `bunview`. The Desktop Entry spec resolves a bare name
  // through the XDG icon theme — meaning a file already installed under ~/.local/share/icons
  // or /usr/share/icons — and nothing here installs one, so every launcher fell back to a
  // generic placeholder. An absolute path is the only file-based form the spec accepts.
  //
  // Like `Exec=` below it, that path is the one on the BUILD machine. Both need rewriting if
  // the release zip is unpacked somewhere else, which is why the two files travel together.
  writeFileSync(
    desktopPath,
    `[Desktop Entry]
Type=Application
Name=${DISPLAY_NAME}
Comment=Chat with Claude on your subscription plan
Exec=${resolve(binaryPath)}
Icon=${resolve(iconPath)}
Terminal=false
Categories=Utility;Development;
# Requires GTK 4 and WebKitGTK 6 at runtime — the webview is the system's, not bundled:
#   Debian/Ubuntu: apt install libgtk-4-1 libwebkitgtk-6.0-4
#   Arch:          pacman -S gtk4 webkitgtk-6.0
`,
  )
  console.log(`  → ${desktopPath}`)
}

await requireStylesheet()
await requireIcon()

if (buildAll || targetArg) {
  const { mkdirSync } = await import('node:fs')
  mkdirSync('dist', { recursive: true })

  const selected = buildAll ? TARGETS : TARGETS.filter((t) => t.name === targetArg)
  if (selected.length === 0) {
    console.error(
      `Unknown target: ${targetArg}\nAvailable: ${TARGETS.map((t) => t.name).join(', ')}`,
    )
    process.exit(1)
  }

  for (const { name, target, ext } of selected) {
    const outfile = `dist/${APP_NAME}-${name}${ext}`
    console.log(`Building for ${name}...`)
    try {
      await buildTarget(outfile, target)
      console.log(`  → ${outfile}`)
      if (name.startsWith('linux-'))
        await makeLinuxDesktop(
          outfile,
          `dist/${APP_NAME}-${name}.desktop`,
          `dist/${APP_NAME}-${name}.png`,
        )
    } catch (e) {
      console.error(`  ✗ Failed to build for ${name}`, e)
      process.exit(1)
    }
  }

  if (buildAll || targetArg?.startsWith('darwin-')) {
    const src = targetArg?.startsWith('darwin-')
      ? `dist/${APP_NAME}-${targetArg}`
      : `dist/${APP_NAME}-darwin-arm64`
    await makeMacApp(src, `dist/${DISPLAY_NAME}-macos.app`)
  }

  console.log('\nDone!')
} else {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const outfile = `./${APP_NAME}${ext}`
  try {
    await buildTarget(outfile)
    if (process.platform === 'darwin') await makeMacApp(outfile, `./${DISPLAY_NAME}-macos.app`)
    console.log('Build successful!')
    console.log(`  → ${outfile}`)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}
