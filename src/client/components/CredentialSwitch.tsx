import { useCallback, useState } from 'react'
import { CreditCard, KeyRound } from 'lucide-react'
import type { AuthResponse } from '../../shared/events'
import { setCredentialMode } from '../lib/api'
import { Button } from './ui/Button'

/**
 * Switch between billing to the user's plan and billing to their API key.
 *
 * WHY THIS EXISTS AS A CONTROL AS WELL AS A DEFAULT.
 *
 * The app deletes `ANTHROPIC_API_KEY` from the CLIs it spawns, and does so by default, because
 * being silently billed per token by an app that says it runs on your subscription is a real
 * footgun. But Anthropic's terms for running Claude Code inside another product say the host
 * may not remove, disable or RESTRICT an authentication method built into it, and the user's
 * own API key is named as one of those methods.
 *
 * This button is half of what keeps the default on the right side of that line: the key path is
 * one labelled click away, next to the badge saying which credential is currently winning,
 * rather than buried in an environment variable no end user would find. (The other half is in
 * providers/claude.ts, which refuses to let the strip take a user's last credential.)
 *
 * RENDERS NOTHING when no override is present in the environment. Two different reasons, same
 * right answer. With no key anywhere there is no second option, and a toggle between one thing
 * and itself implies the plan might not be what is being billed when it certainly is. With a
 * key that came from `apiKeyHelper` or a managed `/login` key there IS a second credential, but
 * it is in the user's Claude settings rather than the environment — this switch strips
 * variables and would do nothing to it. A control that visibly fails to change what it names is
 * worse than none, so AuthBadge names the source in its tooltip instead.
 */
export function CredentialSwitch({
  auth,
  onChanged,
}: {
  auth: AuthResponse | null
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)

  const usingSubscription = auth?.credentialMode === 'subscription'
  const next = usingSubscription ? 'auto' : 'subscription'

  const toggle = useCallback(() => {
    setBusy(true)
    void setCredentialMode(next)
      // Re-probe either way. On failure the badge still reflects the server's real state
      // rather than an optimistic guess that quietly disagrees with what gets billed.
      .catch(() => {})
      .finally(() => {
        setBusy(false)
        onChanged()
      })
  }, [next, onChanged])

  if (!auth?.apiKeyOverride) return null

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      loading={busy}
      disabled={busy}
      title={
        usingSubscription
          ? 'Currently ignoring ANTHROPIC_API_KEY so your plan is billed. Switch to using the key.'
          : 'ANTHROPIC_API_KEY is set and the CLI prefers it. Switch to billing your plan instead.'
      }
    >
      {usingSubscription ? (
        <>
          <KeyRound className="size-3.5" aria-hidden />
          Use API key
        </>
      ) : (
        <>
          <CreditCard className="size-3.5" aria-hidden />
          Use my plan
        </>
      )}
    </Button>
  )
}
