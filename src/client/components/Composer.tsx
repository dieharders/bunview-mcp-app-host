import { useLayoutEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  MODELS,
  type EffortChoice,
  type ModelChoice,
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
  providerLabel,
}: {
  /** Controlled, so a starter prompt can be dropped in from outside. */
  value: string
  onChange: (next: string) => void
  onSend: (prompt: string, model: ModelChoice, effort: EffortChoice) => void
  onStop: () => void
  busy: boolean
  disabled: boolean
  /** Whose agent this is, so the placeholder names the thing the user actually chose. */
  providerLabel: string
}) {
  const [model, setModel] = useState<ModelChoice>(DEFAULT_MODEL)
  const [effort, setEffort] = useState<EffortChoice>(DEFAULT_EFFORT)
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
    onSend(value, model, effort)
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

      <div className="flex items-center gap-2 px-1 pt-1">
        <Select
          label="Model"
          value={model}
          disabled={disabled}
          onChange={(e) => setModel(e.target.value as ModelChoice)}
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m === 'default' ? 'Default model' : m}
            </option>
          ))}
        </Select>

        <Select
          label="Effort"
          value={effort}
          disabled={disabled}
          onChange={(e) => setEffort(e.target.value as EffortChoice)}
        >
          {EFFORTS.map((level) => (
            <option key={level} value={level}>
              {level} effort
            </option>
          ))}
        </Select>

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
