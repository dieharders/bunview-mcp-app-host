import { useCallback, useState } from 'react'
import { CreditCard, KeyRound } from 'lucide-react'
import type { AuthResponse } from '../../shared/events'
import { setCredentialMode } from '../lib/api'
import { Button } from './ui/Button'

/**
 * Switch between billing to the user's plan and billing to their API key.
 *
 * WHY THIS EXISTS AS A CONTROL RATHER THAN A DEFAULT.
 *
 * The app used to delete `ANTHROPIC_API_KEY` from every CLI it spawned. Good intent — being
 * silently billed per token by an app that says it runs on your subscription is a real
 * footgun — but Anthropic's terms for running Claude Code inside another product say the host
 * may not remove or disable an authentication method built into it, and the user's own API key
 * is named as one of those methods. A default that strips it is that removal.
 *
 * So the decision moved to the user, and this is where they make it. The protection is not
 * gone; it is one click, in the header, next to the badge that says which credential is
 * currently winning.
 *
 * RENDERS NOTHING when no override is present in the environment. With no key set there is no
 * second option, and a toggle between one thing and itself is worse than no toggle: it implies
 * the plan might not be what is being billed when it certainly is.
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
