import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '../../shared/events'
import { cn } from '../lib/cn'

/**
 * First-run choice of which vendor's agent to connect to.
 *
 * This gates everything. Nothing is probed before a choice is made, because probing means
 * spawning a vendor's CLI to read the user's account — work that should not happen on a
 * subscription the user has not said they want to use. Once chosen, the app remembers it and
 * this screen does not come back unless the user asks to switch.
 */
export function ProviderPicker({ onChoose }: { onChoose: (id: ProviderId) => void }) {
  return (
    <main className="grid h-full place-items-center p-8">
      <div className="w-full max-w-lg">
        <h1 className="text-lg font-semibold text-white">Connect your AI plan</h1>
        <p className="mt-1 text-sm text-slate-400">
          BunView uses your subscription. The app never sees your credentials.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          {PROVIDER_IDS.map((id) => (
            <ProviderCard key={id} id={id} onChoose={onChoose} />
          ))}
        </div>

        <p className="mt-6 text-xs text-slate-600">You can switch later from the header.</p>
      </div>
    </main>
  )
}

function ProviderCard({ id, onChoose }: { id: ProviderId; onChoose: (id: ProviderId) => void }) {
  const info = PROVIDERS[id]

  return (
    <button
      onClick={() => onChoose(id)}
      className={cn(
        'group flex flex-col gap-1 rounded-2xl border border-white/10 bg-navy-850/70 p-4 text-left',
        'transition hover:border-brand-to/40 hover:bg-navy-800/70',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-via/60',
      )}
    >
      <span className="text-sm font-medium text-slate-100">{info.label}</span>
      <span className="text-xs text-slate-400">Runs on {info.plan}</span>
      <code className="mt-1 w-fit rounded-sm bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-emerald-500">
        {info.vendor}
      </code>
      {/* Said here rather than discovered later: a limitation the user meets after committing
          reads as a bug, but the same sentence up front is just a trade-off. */}
      {info.caveat && <span className="mt-1 text-[11px] text-amber-200/70">{info.caveat}</span>}
    </button>
  )
}
