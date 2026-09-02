import { DEFAULT_PROVIDER, type ProviderId } from '../../shared/events'
import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import type { Provider } from './types'

/**
 * The providers this app can talk to.
 *
 * This is a registry now, where an earlier version was a single exported const with a comment
 * arguing that a registry "earns its keep only when the UI can actually choose". The UI can
 * choose, so it does. Adding a third vendor is one file next to these two plus one line here.
 */
export const PROVIDER_IMPLS: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
}

/** Resolve an id from an untrusted request body, falling back rather than throwing. */
export function getProvider(id: unknown): Provider {
  return typeof id === 'string' && id in PROVIDER_IMPLS
    ? PROVIDER_IMPLS[id as ProviderId]
    : PROVIDER_IMPLS[DEFAULT_PROVIDER]
}
