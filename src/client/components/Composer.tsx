import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  PROVIDERS,
  defaultSettings,
  type EffortChoice,
  type ModelChoice,
  type ProviderId,
} from '../../shared/events'
import { Button } from './ui/Button'
import { Select } from './ui/Select'

const MAX_CHARS = 24_000

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  provider,
}: {
  /** Controlled, so a starter prompt can be dropped in from outside. */
  value: string
  onChange: (next: string) => void
  onSend: (
    prompt: string,
    model: ModelChoice,
    effort: EffortChoice,
    settings: Record<string, string>,
  ) => void
  onStop: () => void
  busy: boolean
  disabled: boolean
  /**
   * Which vendor's agent this is. Takes the ID rather than the label it used to take, because
   * the controls below are now built from this provider's own declared lists — the label was
   * only ever used for the placeholder, and every other value came from a global list that
   * happened to hold Claude's.
   */
  provider: ProviderId
}) {
  const info = PROVIDERS[provider]
  const providerLabel = info.label

  const [model, setModel] = useState<ModelChoice>(DEFAULT_MODEL)
  const [effort, setEffort] = useState<EffortChoice>(DEFAULT_EFFORT)
  const [settings, setSettings] = useState<Record<string, string>>(() => defaultSettings(provider))

  // Switching provider must reset the pickers, not merely re-label them. The lists do not
  // overlap: `opus` is not a Codex model and `minimal` is not a Claude effort, so a selection
  // carried across would be a value the new vendor's CLI rejects. The server coerces these
  // too — this is so the UI stops SHOWING a choice that is no longer on offer.
  useEffect(() => {
    setModel(DEFAULT_MODEL)
    setEffort(DEFAULT_EFFORT)
    setSettings(defaultSettings(provider))
  }, [provider])

  const box = useRef<HTMLTextAreaElement>(null)

  // Auto-grow, driven by the value rather than by the keystroke, so text that never passes
  // through onChange — a starter prompt, the clear after Send — sizes the box too. Reset to
  // auto first, or the box can only ever grow.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    if (value) {
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      // Filled from outside: put the cursor where the user now has to keep typing. Skipped
      // while they type, since the box is already the active element.
      if (document.activeElement !== el) el.focus()
    }
  }, [value])

  const submit = () => {
    if (busy || disabled || !value.trim()) return
    onSend(value, model, effort, settings)
    onChange('')
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-navy-850/80 p-2 focus-within:border-brand-to/40">
      <textarea
        ref={box}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
        maxLength={MAX_CHARS}
        disabled={disabled}
        placeholder={
          disabled ? `Sign in to ${providerLabel} to start…` : `Ask ${providerLabel} anything…`
        }
        className="max-h-52 w-full resize-none bg-transparent px-3 py-2 text-sm text-slate-100 caret-brand-to placeholder:text-slate-500 focus:outline-none disabled:cursor-not-allowed"
      />

      {/* Every control is built from THIS provider's declared lists. Adding a knob to a vendor
          is a data change in shared/events.ts; nothing here needs to know which vendor it is. */}
      <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
        <Select
          label="Model"
          value={model}
          disabled={disabled}
          onChange={(e) => setModel(e.target.value)}
        >
          {info.models.map((m) => (
            <option key={m} value={m}>
              {m === 'default' ? 'Default model' : m}
            </option>
          ))}
        </Select>

        <Select
          label="Effort"
          value={effort}
          disabled={disabled}
          onChange={(e) => setEffort(e.target.value)}
        >
          {info.efforts.map((level) => (
            <option key={level} value={level}>
              {level} effort
            </option>
          ))}
        </Select>

        {info.settings.map((setting) => (
          <Select
            key={setting.id}
            label={setting.label}
            title={setting.hint}
            value={settings[setting.id] ?? setting.values[0]}
            disabled={disabled}
            onChange={(e) => setSettings((prev) => ({ ...prev, [setting.id]: e.target.value }))}
          >
            {setting.values.map((v) => (
              <option key={v} value={v}>
                {`${setting.label.toLowerCase()}: ${v}`}
              </option>
            ))}
          </Select>
        ))}

        <span className="ml-auto text-[11px] text-slate-600">
          {value.length > 0 && `${value.length}/${MAX_CHARS}`}
        </span>

        {busy ? (
          <Button variant="outline" size="sm" onClick={onStop}>
            <Square className="size-3.5" aria-hidden />
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={submit} disabled={disabled || !value.trim()}>
            <Send className="size-3.5" aria-hidden />
            Send
          </Button>
        )}
      </div>
    </div>
  )
}
