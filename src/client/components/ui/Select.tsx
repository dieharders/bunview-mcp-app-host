import type { SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

/**
 * A native select, styled to match.
 *
 * Native rather than a custom listbox because the option popup is rendered by the OS: it
 * escapes the window's bounds, handles keyboard and screen readers for free, and never gets
 * clipped by an overflow container. The one thing it costs is that Chrome on Windows paints
 * the popup light regardless of `color-scheme` — corrected by the `select option` base rule
 * in styles/app.css, not here, because the popup is outside this element's subtree.
 */
export function Select({
  label,
  className = '',
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        className={cn(
          'rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300',
          'transition hover:bg-white/10 focus:outline-none focus-visible:ring-2',
          'focus-visible:ring-brand-via/60 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      />
    </label>
  )
}
