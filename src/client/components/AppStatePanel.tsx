import { NotebookPen } from 'lucide-react'
import type { AppState } from '../../shared/events'

/**
 * The app's own state, rendered live.
 *
 * This panel exists to make the MCP-host seam visible: everything shown here was written by
 * the agent calling a tool defined in `src/server/mcp/app-tools.ts`, which mutates app state
 * in the same process. Ask the agent to set a status and the header changes as it answers.
 */
export function AppStatePanel({ state }: { state: AppState }) {
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 border-l border-white/10 p-4">
      <header className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-slate-500 uppercase">
        <NotebookPen className="size-3.5" aria-hidden />
        App state
      </header>

      <div>
        <p className="text-[11px] text-slate-500">Status</p>
        <p className="text-sm text-slate-200">
          {state.status ?? <span className="text-slate-600">— not set —</span>}
        </p>
      </div>

      <div className="min-h-0 flex-1">
        <p className="text-[11px] text-slate-500">Notes ({state.notes.length})</p>
        {state.notes.length === 0 ? (
          <p className="text-sm text-slate-600">— none —</p>
        ) : (
          <ul className="scrollbar-slim mt-1 flex max-h-full flex-col gap-1.5 overflow-y-auto">
            {state.notes.map((note, i) => (
              <li
                key={`${i}-${note}`}
                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-300"
              >
                {note}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-600">
        Written by agent via MCP tools.
      </p>
    </aside>
  )
}
