/**
 * Open a command in whatever terminal window this OS has.
 *
 * Separate from setup.ts because none of this knows anything about providers, logins or
 * installs — it is OS knowledge, and the next caller that wants a visible terminal (a doctor
 * action, an `mcp login`) should not have to copy the escaping.
 *
 * Two rules hold across all three platforms:
 *
 *   * The caller passes ARGV, never a command string. Every platform needs a different
 *     escaping, and the only way to escape correctly is to still know where the boundaries
 *     between arguments are.
 *   * A launch is only reported as successful once the child has been observed. A terminal
 *     that never opened must not read as a completed sign-in, because the UI's next line is
 *     "finish signing in, then press Retry" and the user will press it forever.
 */
import { basename } from 'node:path'
import { config } from './config'
import { childEnv } from './env'

/** How long a Linux emulator gets to fail before we accept that its window is up. */
const LINUX_SETTLE_MS = 700

/**
 * Wrap one argv element for a POSIX shell.
 *
 * Single quotes rather than escaping, because inside them every character except `'` is
 * literal — no expansion, no globbing, no `$`. The discovered path is not user input, but it
 * routinely contains spaces (`~/Library/Application Support/…`).
 */
export const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Wrap one argv element for PowerShell, whose single quotes are literal like sh's. */
export const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`

/**
 * The command as the user would type it, for the "run it yourself" fallback.
 *
 * Quoted with the SAME rules the spawn uses, which is the whole reason this lives beside
 * `openInTerminal` rather than being rebuilt at the call site. An earlier version quoted only
 * on whitespace and only with double quotes: unsafe in cmd (`&` splits), unrunnable in
 * PowerShell (a leading quoted token parses as an expression), and still expanding `$` and
 * backticks on POSIX.
 *
 * Windows targets PowerShell, which is the default shell of Windows Terminal on Windows 11.
 * `&` is its call operator — without it a quoted first token is a string expression, not a
 * command.
 */
export function displayCommand(argv: string[]): string {
  if (process.platform === 'win32') return `& ${argv.map(psQuote).join(' ')}`
  return argv.map(shQuote).join(' ')
}

/**
 * Build the command line for `cmd /s /k`.
 *
 * WHY THE OUTER QUOTE PAIR. `cmd /?` documents that with `/s`, cmd strips the first character
 * and the last quote character of the remainder and runs the rest verbatim. So one outer pair
 * wrapping an already-correctly-quoted command line is the one form that survives cmd intact.
 *
 * Without `/s` the rules are conditional and lose: quotes are preserved ONLY when the
 * remainder holds exactly two quote characters, with no `&<>()@^|` between them, around the
 * name of an existing executable. A Node-launcher install is two quoted paths — four quotes —
 * so cmd falls back to stripping the outer two and the window opens on
 * "'C:\Program' is not recognized". `C:\Program Files (x86)\nodejs\node.exe` fails the same
 * way on the parens alone, with only two quotes.
 *
 * Every element is quoted unconditionally: Windows paths cannot contain `"`, so there is
 * nothing to escape, and quoting everything removes the "does this one need it" judgement
 * that produced the bug in the first place.
 */
export const winCommandLine = (argv: string[]) => `"${argv.map((a) => `"${a}"`).join(' ')}"`

/**
 * Launch `argv` in a new terminal window. Resolves false when no window could be opened.
 *
 * Async because the answer is not knowable synchronously: on Windows and macOS the launcher
 * process exits within milliseconds and its exit code is the only evidence that a window
 * actually appeared. macOS is the case that matters — an app that has not been granted
 * Automation → Terminal exits with -1743 and opens nothing at all.
 */
export async function openInTerminal(argv: string[]): Promise<boolean> {
  const opts = {
    stdout: 'ignore',
    stderr: 'ignore',
    env: childEnv(),
    cwd: config.cwd,
  } as const

  if (process.platform === 'win32') {
    // `start` is a cmd builtin, so it needs cmd. The empty "" is the window TITLE argument —
    // without it, `start` treats a quoted command as the title and opens an empty shell.
    // `/k` keeps the window open afterwards so the user can read the result.
    //
    // windowsVerbatimArguments because this command line is already exactly right and Bun's
    // own escaping would rewrite the inner quotes as `\"`, which cmd does not treat as an
    // escape. Passing the parts separately and letting Bun quote them is what fails above.
    const proc = Bun.spawn(
      ['cmd.exe', '/c', 'start', '""', 'cmd.exe', '/s', '/k', winCommandLine(argv)],
      { ...opts, windowsVerbatimArguments: true },
    )
    return (await proc.exited) === 0
  }

  const command = argv.map(shQuote).join(' ')

  if (process.platform === 'darwin') {
    // `cd` inside the script, because `opts.cwd` cannot reach here. `do script` is an Apple
    // Event to Terminal.app — a separate, already-running process — so the window it opens
    // inherits Terminal's own working directory, not this one. The spawn option below applies
    // to `osascript` and nothing else.
    //
    // The same is true of `env`: the window's shell is Terminal's child, so childEnv()'s
    // stripping does not reach it. Left as is deliberately. The point of handing sign-in to a
    // terminal is to use the vendor's own interactive path in the user's own shell, and a
    // login shell re-sources their profile anyway — on Linux too, where `bash -lc` undoes it
    // just the same. Worth knowing that `claude auth status`, which this app runs stripped,
    // can therefore disagree with a login performed here when CLAUDE_CODE_USE_BEDROCK is set.
    const withCwd = `cd ${shQuote(config.cwd)} && ${command}`

    // Two escaping layers, not one: `withCwd` is already shell-safe, and this embeds it in an
    // AppleScript string literal, where `\` and `"` are the two characters that would end it.
    const script = withCwd.replaceAll('\\', '\\\\').replaceAll('"', '\\"')

    // One osascript, not two. Two processes race — `activate` can land before `do script` —
    // and the second one paid for a whole second environment block to say one word.
    const proc = Bun.spawn(
      [
        'osascript',
        '-e',
        'tell application "Terminal"',
        '-e',
        `do script "${script}"`,
        '-e',
        'activate',
        '-e',
        'end tell',
      ],
      opts,
    )
    return (await proc.exited) === 0
  }

  // Linux has no single answer; try the usual suspects in order of how likely they are to be
  // the session's actual terminal.
  for (const term of [
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'xterm',
  ]) {
    const resolved = Bun.which(term)
    if (!resolved) continue

    // Match on what the name RESOLVES to, not the name we looked up. On Debian and Ubuntu
    // `x-terminal-emulator` is an alternatives link — usually to gnome-terminal — and it is
    // tried first, so comparing the literal would send every GNOME desktop down the branch
    // written for something else.
    const real = basename(resolved).toLowerCase()

    // `exec bash` keeps the window open after the flow finishes, matching /k on Windows.
    const payload = `${command}; exec bash`

    // Each of these takes the command as SEPARATE arguments. An earlier version passed
    // `-e "bash -lc '…'"` as one string, which only xfce4-terminal re-splits; xterm and
    // konsole execvp it directly and die on a program literally named `bash -lc '…'`.
    const args = real.startsWith('gnome-terminal')
      ? ['--', 'bash', '-lc', payload]
      : real.startsWith('xfce4-terminal')
        ? ['-x', 'bash', '-lc', payload]
        : ['-e', 'bash', '-lc', payload]

    const proc = Bun.spawn([resolved, ...args], opts)

    // Unlike Windows and macOS the emulator IS the window, so it stays alive for as long as
    // the user needs it — waiting for exit would hang the request. Give it just long enough
    // to fail (a bad exec dies immediately) and otherwise take the running process as proof.
    const settled = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LINUX_SETTLE_MS)),
    ])

    if (settled === null) {
      // Ours no longer: the window must outlive this app, so stop waiting on it at exit.
      proc.unref()
      return true
    }
    if (settled === 0) return true
    // Exited non-zero straight away — wrong emulator or a bad exec. Try the next one.
  }

  return false
}
