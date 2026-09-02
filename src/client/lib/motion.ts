/**
 * Does the user want reduced motion?
 *
 * Checked in JS rather than left to the stylesheet because a `behavior` asked for in a
 * scripted `scrollTo` call beats the `scroll-behavior` guard in CSS — the media query in
 * app.css cannot override an argument passed at the call site.
 *
 * Guarded for environments with no `matchMedia` (the test DOM), where the honest answer is
 * "no preference expressed".
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
