/**
 * Command construction for a terminal window, tested without opening one.
 *
 * These pieces used to live inside `spawnInTerminal`, which spawns — so the only way to
 * exercise them was to stub `Bun.spawn` and read the argv array, which observes the layer
 * ABOVE the bug. The Windows defect is in how cmd.exe re-parses a command line, and that is
 * a string, so pulling the string-building out is what makes it assertable on any machine
 * instead of only on the one platform where it breaks.
 */
import { describe, expect, test } from 'bun:test'
import { displayCommand, psQuote, shQuote, winCommandLine } from './terminal'

/** The install that actually regressed: npm-global Codex is always `[node, codex.js]`. */
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const JS = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'

describe('winCommandLine', () => {
  test('survives what cmd /s does to it', () => {
    const line = winCommandLine([NODE, JS, 'login'])

    // `cmd /s /k <remainder>` is documented to strip the first character and the last quote
    // character, then run the rest verbatim. Reproduce exactly that and check what cmd is
    // left holding.
    expect(line[0]).toBe('"')
    const afterCmdStripsIt = line.slice(1, line.lastIndexOf('"'))

    expect(afterCmdStripsIt).toBe(`"${NODE}" "${JS}" "login"`)
  })

  test('quotes every element, so four quotes cannot become a mangled path', () => {
    // Without the outer pair this is the exact regression: two quoted paths are four quote
    // characters, cmd's preserve rule needs exactly two, and the fallback strips the outer
    // two — leaving the window on "'C:\Program' is not recognized".
    const line = winCommandLine([NODE, JS, 'login'])

    expect(line).toContain(`"${NODE}"`)
    expect(line).toContain(`"${JS}"`)
  })

  test('quotes a path containing cmd metacharacters', () => {
    // `&` is legal in a Windows account name and needs no space to break an unquoted command:
    // cmd would run `C:\Users\R` and then treat the rest as a second command.
    const line = winCommandLine(['C:\\Users\\R&D\\codex.exe', 'login'])

    expect(line.slice(1, line.lastIndexOf('"'))).toBe('"C:\\Users\\R&D\\codex.exe" "login"')
  })

  test('quotes a path containing parentheses', () => {
    // 32-bit Node. Parens defeat cmd's preserve rule even with only two quote characters, so
    // this one broke without needing an unusual username.
    const line = winCommandLine(['C:\\Program Files (x86)\\nodejs\\node.exe', 'login'])

    expect(line.slice(1, line.lastIndexOf('"'))).toBe(
      '"C:\\Program Files (x86)\\nodejs\\node.exe" "login"',
    )
  })
})

describe('shQuote', () => {
  test('leaves everything inside literal', () => {
    // Single quotes are the point: no expansion, no globbing, no `$`.
    expect(shQuote('/opt/my$tools/codex')).toBe(`'/opt/my$tools/codex'`)
    expect(shQuote('/Users/j/Library/Application Support/x')).toBe(
      `'/Users/j/Library/Application Support/x'`,
    )
  })

  test('closes and reopens around an embedded quote', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe('psQuote', () => {
  test('doubles a single quote, which is PowerShell’s own escape', () => {
    expect(psQuote("it's")).toBe("'it''s'")
    expect(psQuote('C:\\Program Files\\node.exe')).toBe("'C:\\Program Files\\node.exe'")
  })
})

describe('displayCommand', () => {
  test('is pasteable into the shell this platform actually opens with', () => {
    const cmd = displayCommand(['/opt/my tools/codex', 'login'])

    if (process.platform === 'win32') {
      // PowerShell is the Windows 11 default, and there a leading quoted token is a string
      // expression rather than a command — `&` is what makes it run.
      expect(cmd.startsWith('& ')).toBe(true)
    } else {
      expect(cmd).toBe(`'/opt/my tools/codex' 'login'`)
    }
  })

  test('never leaves a variable live for the shell to expand', () => {
    const cmd = displayCommand(['/opt/my$tools/codex', 'login'])

    // The old version wrapped in DOUBLE quotes, under which $tools expands to nothing and the
    // advice silently names a different path than the one that was spawned.
    expect(cmd).not.toContain('"')
    expect(cmd).toContain('$tools')
  })
})
