/**
 * Module declarations for `import x from "./y" with { type: "file" }`.
 *
 * Bun resolves those imports to a path string it can read back with `Bun.file()`, and embeds
 * the file into the standalone executable under `--compile`. TypeScript has no idea that is
 * what the import attribute means, so without these it errors on every asset import.
 *
 * Currently only needed on the Plan-B frontend path (see README: "Frontend fallback"), where
 * the client is pre-bundled and served from embedded files rather than through Bun's HTML
 * entrypoint. Kept in place regardless so that fallback stays a one-file edit.
 */
declare module '*.css' {
  const path: string
  export default path
}

declare module '*.html' {
  const path: string
  export default path
}

declare module '*.js' {
  const path: string
  export default path
}
