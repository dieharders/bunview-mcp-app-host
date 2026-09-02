import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { buttonCls, type ButtonSize, type ButtonVariant } from './button-styles'
import { Spinner } from './Spinner'

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  children: ReactNode
}) {
  return (
    <button
      className={buttonCls({ variant, size, className })}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  )
}
