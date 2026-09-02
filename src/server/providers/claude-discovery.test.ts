import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { discoverClaude, resetDiscovery } from './claude-discovery'

const ORIGINAL = process.env.BUNVIEW_CLAUDE_PATH

beforeEach(() => resetDiscovery())

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BUNVIEW_CLAUDE_PATH
  else process.env.BUNVIEW_CLAUDE_PATH = ORIGINAL
  resetDiscovery()
})

describe('discoverClaude', () => {
  test('finds a real executable on this machine', async () => {
    delete process.env.BUNVIEW_CLAUDE_PATH
    const found = await discoverClaude()

    expect(found.path).toBeTruthy()
    expect(found.searched.length).toBeGreaterThan(0)
  })

  test('never returns a Windows shim as the spawn target', async () => {
    delete process.env.BUNVIEW_CLAUDE_PATH
    const found = await discoverClaude()

    // Spawning a .cmd routes through cmd.exe, which re-parses the prompt as a command line
    // and reparents the real process beyond the reach of kill(). See the module header.
    expect(found.path ?? '').not.toMatch(/\.(cmd|ps1|bat)$/i)
  })

  test('a bad explicit override fails hard rather than falling through to discovery', async () => {
    process.env.BUNVIEW_CLAUDE_PATH = '/definitely/not/here/claude'
    const found = await discoverClaude()

    // Silently running a different binary than the one the operator named is the worst
    // outcome available: it looks like it worked.
    expect(found.path).toBeNull()
    expect(found.searched.some((s) => s.includes('BUNVIEW_CLAUDE_PATH'))).toBe(true)
  })

  test('memoises, so repeated calls do not re-stat the filesystem', async () => {
    delete process.env.BUNVIEW_CLAUDE_PATH
    const a = await discoverClaude()
    const b = await discoverClaude()

    expect(a).toBe(b)
  })
})
