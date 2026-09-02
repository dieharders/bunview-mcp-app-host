import { claudeProvider } from './claude'
import type { Provider } from './types'

/**
 * The active provider.
 *
 * One line to swap, and deliberately NOT a registry. A `Map<string, Provider>` plus a factory
 * plus a selection UI earns its keep only when there is more than one provider AND the user
 * can choose between them; building that machinery for a choice that does not exist yet is
 * exactly the over-abstraction a scaffold should refuse. Adding Codex or Gemini later means
 * writing one file next to ./claude.ts and changing this line.
 */
export const provider: Provider = claudeProvider
