/**
 * The MCP-host seam — the reason this scaffold exists.
 *
 * The app is the MCP *host*, not an MCP server: it owns the conversation and the model, and
 * it registers its own tool surface INTO the agent session. MCP carries tools and nothing
 * else — it has no concept of a conversation, a model, or a subscription — so it always
 * needs a host that already has a model attached. That host is this app.
 *
 * `createSdkMcpServer` runs these tools IN THIS PROCESS. That is the whole trick: the
 * handlers below close over `../state`, so when the agent calls `set_status` it mutates the
 * same object the UI is rendering, with no IPC and no serialization boundary. The alternative
 * — pointing `--mcp-config` at a real server over stdio or HTTP — would put a process
 * boundary between the agent's tools and the app's state and force you to build a protocol
 * across it.
 *
 * TO FORK THIS: delete the three toy tools and register the app's real domain tools. Nothing
 * else in the project needs to change. The `annotations` matter — `readOnlyHint` tells the
 * model (and any permission UI) that a tool observes rather than mutates.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { addNote, getState, setStatus } from '../state'

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

export const appToolsServer = createSdkMcpServer({
  name: 'bunview',
  version: '0.1.0',
  instructions:
    'Tools for driving the BunView app window. Use set_status to tell the user what you are ' +
    'doing, and add_note to leave something on screen that outlives this message.',
  tools: [
    tool(
      'set_status',
      'Set the status line shown in the app header. Use it to report what you are doing.',
      { text: z.string().min(1).max(200).describe('The status line to display') },
      async ({ text }) => ok(`Status set to: ${setStatus(text).status}`),
      { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
    ),

    tool(
      'add_note',
      'Append a note to the notes panel in the app window.',
      { text: z.string().min(1).max(500).describe('The note to append') },
      async ({ text }) => ok(`Note added. There are now ${addNote(text).notes.length} notes.`),
      { annotations: { readOnlyHint: false, destructiveHint: false } },
    ),

    tool(
      'get_app_state',
      'Read the current app state: the status line and every note.',
      {},
      async () => ok(JSON.stringify(getState())),
      { annotations: { readOnlyHint: true } },
    ),
  ],
})
