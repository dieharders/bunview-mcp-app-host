import { extendTailwindMerge, type ClassNameValue } from 'tailwind-merge'

/**
 * Merge Tailwind classes, last one wins.
 *
 * The `extend` is not decoration. Two utilities that set the same CSS property are
 * equal-specificity rules, so the winner is stylesheet order, not the order they appear in
 * the class attribute — which means `<Button className="bg-white/5">` would silently lose to
 * the variant's `bg-gradient-brand`, or beat it, depending on where Tailwind happened to emit
 * them. tailwind-merge resolves that by knowing which utilities conflict, and it can only
 * know about custom ones if we tell it: `bg-gradient-brand` starts with `bg-`, so an
 * unconfigured merge files it under background-COLOUR and a later `bg-white/5` deletes it,
 * leaving the primary button unfilled.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'bg-image': ['bg-gradient-brand'],
    },
  },
})

export function cn(...classes: ClassNameValue[]): string {
  return twMerge(...classes)
}
