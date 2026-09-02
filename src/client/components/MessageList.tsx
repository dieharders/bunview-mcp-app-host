import { useEffect, useRef } from 'react'
import { Sparkles, Wrench } from 'lucide-react'
import type { ChatMessage } from '../hooks/useClaudeStream'
import { cn } from '../lib/cn'
import { prefersReducedMotion } from '../lib/motion'

/**
 * The conversation, as bubbles.
 *
 * Frameless on purpose — the caller supplies the card and the height it scrolls in.
 */
export function MessageList({
  messages,
  waiting,
  className,
}: {
  messages: ChatMessage[]
  /** True between Send and the first token: show the indicator with no bubble behind it. */
  waiting: boolean
  className?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const seen = useRef(messages.length)

  useEffect(() => {
    const el = scroller.current
    if (!el) return

    el.scrollTop = el.scrollHeight

    const onScroll = () => {
      // 80px of slack, so "nearly at the bottom" still counts as following along. Requiring
      // exactly 0 would stop auto-scrolling the moment a trackpad overshot by a pixel.
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scroller.current
    // Scroll only when there is something NEW and the reader has not deliberately scrolled
    // up to read something earlier — yanking them back to the bottom mid-sentence is worse
    // than letting the new text arrive off-screen.
    if (!el || !atBottom.current) {
      seen.current = messages.length
      return
    }
    seen.current = messages.length
    // Optional call: the test DOM implements no scrolling at all.
    el.scrollTo?.({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  })

  return (
    <div
      ref={scroller}
      className={cn('scrollbar-slim flex flex-col gap-3 overflow-y-auto px-4 py-4', className)}
      aria-live="polite"
      aria-label="Conversation"
    >
      {messages.map((message, index) => (
        // Keyed by the message's own id rather than its position, so a re-render never
        // remounts a bubble and replays its entrance animation on the whole thread.
        <Bubble key={message.id} message={message} isLast={index === messages.length - 1} />
      ))}

      {waiting && <TypingIndicator />}

      {messages.length === 0 && !waiting && (
        <p className="m-auto max-w-sm text-center text-sm text-slate-500">
          Ask something. Claude runs on your subscription — no API key involved.
        </p>
      )}
    </div>
  )
}

function Bubble({ message, isLast }: { message: ChatMessage; isLast: boolean }) {
  const isUser = message.role === 'user'

  // An assistant bubble with no text yet and no tools would render as an empty box; the
  // typing indicator is already covering that moment.
  if (!isUser && !message.text && message.tools.length === 0 && isLast) return null

  return (
    <div
      className={cn('flex animate-bubble-in flex-col gap-1', isUser ? 'items-end' : 'items-start')}
    >
      {message.tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {message.tools.map((tool, i) => (
            <span
              key={`${tool}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-400"
            >
              <Wrench className="size-3" aria-hidden />
              {tool}
            </span>
          ))}
        </div>
      )}

      {message.text && (
        <div
          className={cn(
            'w-fit max-w-[85%] rounded-2xl border px-3.5 py-2 text-sm/relaxed',
            'wrap-break-word whitespace-pre-wrap',
            isUser
              ? 'rounded-br-sm border-brand-via/30 bg-brand-via/15 text-slate-100'
              : 'rounded-bl-sm border-white/10 bg-white/5 text-slate-200',
          )}
        >
          {message.text}
        </div>
      )}
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2" aria-label="Waiting for a response">
      <span className="bg-gradient-brand grid size-6 shrink-0 place-items-center rounded-full">
        <Sparkles className="size-3 text-white" aria-hidden />
      </span>
      <div className="flex w-fit items-center gap-1 rounded-2xl rounded-bl-sm border border-white/10 bg-white/5 px-3 py-2.5">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1.5 animate-pulse rounded-full bg-slate-500"
            style={{ animationDelay: `${dot * 200}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
