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
export {}

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

async function buildTarget(outfile: string, target?: string) {
  const result = await Bun.build({
    // BOTH entrypoints. `main.ts` spawns `src/server/worker.ts` as a Worker, and a
    // worker module that is not an entrypoint does not make it into the compiled binary —
    // the app then dies at launch with a module-resolution error inside the Worker.
    entrypoints: ['./main.ts', './src/server/worker.ts'],
    compile: {
      outfile,
      ...(target ? { target: target as never } : {}),
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
 * Patch a Windows PE executable so it runs as a GUI app (no console window behind it).
 * Changes the Subsystem field from CONSOLE (3) to WINDOWS (2).
 *
 * This is the same technique as Microsoft's `editbin /SUBSYSTEM:WINDOWS`. We do it by hand
 * because Bun's own `--windows-hide-console` is broken (oven-sh/bun#19916) and does not
 * support cross-compilation anyway. Pure byte editing, so it works when cross-compiling
 * from macOS or Linux too.
 */
async function patchWindowsSubsystem(exePath: string) {
  const buf = Buffer.from(await Bun.file(exePath).arrayBuffer())

  // The DOS header must be at least 0x40 bytes to contain e_lfanew.
  if (buf.length < 0x40) throw new Error('File too small to be a valid PE executable')

  const peOffset = buf.readUInt32LE(0x3c) // e_lfanew
  // Optional header starts after the PE signature (4) + COFF header (20); Subsystem sits at
  // offset 68 within it.
  const subsystemOffset = peOffset + 4 + 20 + 68

  if (subsystemOffset + 2 > buf.length) throw new Error('PE file is truncated')
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0')
    throw new Error('Not a valid PE file')

  if (buf.readUInt16LE(subsystemOffset) === 3) {
    buf.writeUInt16LE(2, subsystemOffset) // IMAGE_SUBSYSTEM_WINDOWS_CUI -> _GUI
    await Bun.write(exePath, buf)
    console.log('  → Patched PE subsystem to GUI (no console window)')
  }
}

/** macOS needs a bundle plus a signature, or Gatekeeper refuses to launch the binary. */
async function makeMacApp(binaryPath: string, appDir: string) {
  const { mkdirSync, writeFileSync, chmodSync, copyFileSync, existsSync } = await import('node:fs')
  if (!existsSync(binaryPath)) return

  const contentsDir = `${appDir}/Contents`
  mkdirSync(`${contentsDir}/MacOS`, { recursive: true })
  mkdirSync(`${contentsDir}/Resources`, { recursive: true })

  copyFileSync(binaryPath, `${contentsDir}/MacOS/${APP_NAME}`)
  chmodSync(`${contentsDir}/MacOS/${APP_NAME}`, 0o755)

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
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
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

async function makeLinuxDesktop(binaryPath: string, desktopPath: string) {
  const { writeFileSync, existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  if (!existsSync(binaryPath)) return

  writeFileSync(
    desktopPath,
    `[Desktop Entry]
Type=Application
Name=${DISPLAY_NAME}
Comment=Chat with Claude on your subscription plan
Exec=${resolve(binaryPath)}
Icon=${APP_NAME}
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
      if (ext === '.exe') await patchWindowsSubsystem(outfile)
      console.log(`  → ${outfile}`)
      if (name.startsWith('linux-'))
        await makeLinuxDesktop(outfile, `dist/${APP_NAME}-${name}.desktop`)
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
    if (process.platform === 'win32') await patchWindowsSubsystem(outfile)
    if (process.platform === 'darwin') await makeMacApp(outfile, `./${DISPLAY_NAME}-macos.app`)
    console.log('Build successful!')
    console.log(`  → ${outfile}`)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}
