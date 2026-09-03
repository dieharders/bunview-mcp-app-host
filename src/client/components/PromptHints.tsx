import { Activity, ListPlus, ScanEye, type LucideIcon } from 'lucide-react'

/**
 * Starter prompts for the app's own MCP tools.
 *
 * One per tool in `src/server/mcp/app-tools.ts`, because an empty window is a poor
 * explanation of what this scaffold does: the panel on the right stays blank until the agent
 * calls a tool, and nothing on screen says how to make that happen.
 *
 * Clicking FILLS the composer rather than sending. These are examples to read and edit, not
 * shortcuts — and a prompt that fires an agent turn on the user's subscription should take a
 * deliberate second click.
 *
 * TO FORK THIS: replace these three alongside the tools they demonstrate, or delete the file
 * and the `onPickPrompt` prop on MessageList.
 */
const HINTS: { tool: string; icon: LucideIcon; label: string; prompt: string }[] = [
  {
    tool: 'set_status',
    icon: Activity,
    label: 'Set the status line',
    prompt: 'Set the app status to “reading the codebase”, then tell me what it says now.',
  },
  {
    tool: 'add_note',
    icon: ListPlus,
    label: 'Leave a note on screen',
    prompt: 'Add a note for each tool this app registers, saying what it does in a few words.',
  },
  {
    tool: 'get_app_state',
    icon: ScanEye,
    label: 'Read the state back',
    prompt: 'Read the current app state and summarise the status line and every note.',
  },
]

export function PromptHints({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Starter prompts">
      {HINTS.map(({ tool, icon: Icon, label, prompt }) => (
        <button
          key={tool}
          type="button"
          onClick={() => onPick(prompt)}
          title={prompt}
          className="group flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left transition hover:border-brand-via/40 hover:bg-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-via/60"
        >
          <Icon
            className="size-4 shrink-0 text-slate-500 transition group-hover:text-brand-to"
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block text-xs text-slate-300">{label}</span>
            <span className="block truncate font-mono text-[11px] text-slate-600">{tool}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
