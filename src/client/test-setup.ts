import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach } from 'bun:test'

// Registers document/window/etc. on globalThis so @testing-library/react can render.
// Preloaded via bunfig.toml rather than imported per-test, because this must run before
// React is imported anywhere.
GlobalRegistrator.register()

// @testing-library/react auto-cleans between tests only when it detects a global `afterEach`
// from a framework it recognises, which it does not under `bun test`. Without this, every
// render stays mounted and queries like getByLabelText start matching elements left behind by
// earlier tests — which fails as "multiple elements" in a way that looks like a bug in the
// component rather than in the harness.
const { cleanup } = await import('@testing-library/react')
afterEach(cleanup)
