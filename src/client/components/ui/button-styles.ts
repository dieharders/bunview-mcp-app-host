import { cn } from '../../lib/cn'

/**
 * Button class strings.
 *
 * A sibling module rather than exports from Button.tsx because `react-refresh` wants a
 * component file to export only components — mixing constants in breaks fast refresh for the
 * whole file.
 */
export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-via/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-gradient-brand text-white shadow-lg shadow-brand-via/20 hover:brightness-110',
  outline: 'border border-white/15 bg-white/5 text-slate-100 hover:bg-white/10',
  ghost: 'text-slate-300 hover:bg-white/5 hover:text-white',
  danger: 'border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 py-1.5 text-xs',
  md: 'min-h-10 px-4 py-2.5 text-sm',
}

export function buttonCls({
  variant = 'primary',
  size = 'md',
  className = '',
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(base, variants[variant], sizes[size], className)
}
