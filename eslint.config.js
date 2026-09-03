import js from '@eslint/js'
import globals from 'globals'
import betterTailwind from 'eslint-plugin-better-tailwindcss'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `dist` is `bun run build` output — bundled copies of files we already lint at their source,
  // so linting it reports every finding twice and adds findings for generated code nobody edits.
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      // Both halves of the app share one tree: `src/client` runs inside the webview, while
      // `src/server`, main.ts and build.ts run in Bun. Merging the global sets beats splitting
      // this config by directory — `no-undef` is off for TS files anyway (tseslint's
      // eslint-recommended disables it because tsc already reports undefined names), so the
      // globals only feed rules that ask "is this a browser API?", not correctness.
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Bun's dev server injects React Fast Refresh on its own: worker.ts serves an imported
      // `index.html`, and `Bun.serve` defaults `development` to NODE_ENV !== 'production'.
      // Nothing here opts in, so the rule guards a transform we really do run under `bun dev`.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // `^_` matches what tsc already does: `noUnusedParameters` is on in tsconfig and TS
      // exempts underscore-prefixed params by convention, which is why `canInstall(_provider)`
      // and the `mock((_: string) => {})` stubs in the tests are written that way. Without
      // this the linter contradicts the compiler on code that is deliberately shaped for it.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // `declare var self: Worker` is an ambient type-only declaration — it emits no runtime `var`,
  // and `var` is the idiomatic form for declaring a global binding. `no-var` cannot tell the
  // two apart, so it fires on the one line in this repo where `var` is correct.
  { files: ['src/server/worker.ts'], rules: { 'no-var': 'off' } },

  // React rules the TS compiler can't see: a missing `key`, a raw `>` in JSX text, state
  // mutated in place. `detect` reads the installed React rather than us pinning a version
  // here that then drifts from package.json.
  {
    files: ['**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      // Off: it asks for a runtime `propTypes` declaration to describe props the TS types
      // already describe, and it can only see the shapes it recognises — a props type behind
      // an alias, a spread, or a `forwardRef` reads to it as undeclared. Clean today; the
      // failure mode is a false error on the next component that types its props indirectly.
      'react/prop-types': 'off',
    },
  },
  // `jsx: 'react-jsx'` in tsconfig means `React` is never in scope and never needs to be —
  // without this, every component file is an error for not importing something Bun injects.
  { files: ['**/*.{ts,tsx}'], ...react.configs.flat['jsx-runtime'] },

  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'better-tailwindcss': betterTailwind },
    settings: {
      // Tailwind v4 has no JS config to read — the theme IS the `@theme` block in app.css, so
      // the plugin loads that file to learn our tokens. Without it, `bg-navy-850`,
      // `text-brand-to` and `animate-bubble-in` are unknown classes and `no-unknown-classes`
      // flags the entire design system.
      'better-tailwindcss': { entryPoint: 'src/client/styles/app.css' },
    },
    rules: {
      ...betterTailwind.configs.recommended.rules,
      // Two utilities for one property are two rules of equal specificity, so the winner is
      // whichever Tailwind emitted last — NOT the one written last. `cn` resolves this at
      // runtime via tailwind-merge; this catches the pairs `cn` never sees, where both classes
      // sit inside a single string literal.
      'better-tailwindcss/no-conflicting-classes': 'error',
      // Off: it rewraps long class strings to a column budget, which reflows nearly every
      // component here and fights Prettier over the result. Ordering and conflicts are the
      // value; line shape is already Prettier's job (printWidth 100).
      'better-tailwindcss/enforce-consistent-line-wrapping': 'off',
      'better-tailwindcss/no-unknown-classes': [
        'error',
        {
          // `bg-gradient-brand` is real CSS in app.css, but it is declared as a plain
          // `.bg-gradient-brand {}` inside `@layer components` — v4 only REGISTERS a custom
          // utility declared with `@utility`, so to the plugin (and to variants like `hover:`)
          // it does not exist. `scrollbar-slim` needs no entry here precisely because it IS
          // declared with `@utility`; converting this one the same way is the better fix and
          // would let the ignore go.
          ignore: ['^bg-gradient-brand$'],
        },
      ],
    },
  },
)
