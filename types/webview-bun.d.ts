/**
 * Type stub for `webview-bun`, used by `bun run typecheck` INSTEAD of the package's own
 * source. See tsconfig.typecheck.json for the mapping that redirects here.
 *
 * The package ships raw .ts rather than compiled output plus .d.ts, so tsc typechecks the
 * library itself — and it does not pass under `strict` (it assigns a `bigint | Pointer | null`
 * to a `Pointer | null`, because a bun:ffi Pointer is typed as `number` but can be a `bigint`
 * at runtime). `skipLibCheck` only covers .d.ts files, so it cannot suppress that.
 *
 * The previous workaround was to route the import specifier through a variable so tsc could
 * not follow it. That worked for tsc and quietly broke the build: Bun's bundler discovers
 * modules by STATIC ANALYSIS of the specifier, so whether `webview-bun` was embedded in the
 * compiled binary depended on the minifier happening to inline that const. Two builds from
 * the same source produced one working binary and one that silently fell back to browser
 * mode. Declaring the shape here keeps the specifier a literal, which the bundler can always
 * see, while tsc never opens the package.
 *
 * Only the surface this app uses is declared. Widen it if the app starts using more.
 */
declare module 'webview-bun' {
  /** Window size hints. 0 = NONE (resizable), 1 = MIN, 2 = MAX, 3 = FIXED. */
  export type SizeHint = 0 | 1 | 2 | 3

  export interface Size {
    width: number
    height: number
    hint: SizeHint
  }

  export class Webview {
    title: string
    size: Size
    navigate(url: string): void
    /** Blocks on a native event loop until the window is closed. */
    run(): void
    /**
     * The platform's native window handle — an HWND on Windows. Needed to set the window's
     * icon, which Windows does not inherit from the executable's own icon resource.
     */
    readonly unsafeWindowHandle: number | bigint | null
  }
}
