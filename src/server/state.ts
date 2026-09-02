/**
 * The app's own state — the thing the agent reaches through MCP.
 *
 * This is deliberately trivial (a status line and a list of notes) because its job is to be
 * REPLACED. In a real app this module is the editor document, the timeline, the project
 * model: whatever the agent should be able to read and change. The important property is
 * that it lives in the same process as the tools in `mcp/app-tools.ts`, so a tool handler
 * mutates it with a plain assignment — no IPC, no serialization, no round trip.
 *
 * `version` is what lets the chat stream notice a change without any event plumbing: the
 * provider samples it between agent messages and emits a `state` event when it moves.
 * A counter is enough because there is exactly one writer (the agent's tool calls) and the
 * reader only needs to know "different from last time", not what changed.
 */
import type { AppState } from '../shared/events'

const MAX_NOTES = 50

let status: string | null = null
let notes: string[] = []
let version = 0

export function getState(): AppState {
  return { status, notes: [...notes] }
}

export function getVersion(): number {
  return version
}

export function setStatus(next: string): AppState {
  status = next
  version += 1
  return getState()
}

export function addNote(note: string): AppState {
  // Bounded: the agent is the writer, and an agent in a loop would otherwise grow this
  // without limit for as long as the window stays open.
  notes = [...notes, note].slice(-MAX_NOTES)
  version += 1
  return getState()
}

export function resetState(): AppState {
  status = null
  notes = []
  version += 1
  return getState()
}
