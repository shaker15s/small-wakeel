'use client'

// وكيل — Composer: quick chips + autosizing textarea + send & mic buttons.
// Enter sends, Shift+Enter adds a newline. The textarea grows 1→4 rows
// (44px → 128px) with zero layout shift.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Mic } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const MAX_HEIGHT = 128 // 4 rows max (max-h-32)

export function Composer({
  chips,
  onSend,
  disabled,
  onVoiceClick,
}: {
  chips: string[]
  onSend: (text: string) => void
  disabled?: boolean
  /** voice input hook — optional; the mic stays a disabled teaser without it */
  onVoiceClick?: () => void
}) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autosize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  useEffect(() => {
    autosize()
  }, [value, autosize])

  const send = useCallback(() => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
    textareaRef.current?.focus()
  }, [value, disabled, onSend])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const canSend = value.trim().length > 0 && !disabled

  return (
    <div className="flex w-full flex-col gap-2">
      {/* quick chips (horizontal scroll) */}
      {chips.length > 0 && (
        <div
          className="scroll-warm flex gap-1.5 overflow-x-auto pb-1"
          role="group"
          aria-label="اقتراحات سريعة"
        >
          {chips.map((chip) => (
            <Button
              key={chip}
              type="button"
              variant="secondary"
              size="sm"
              className="press h-8 shrink-0 rounded-full text-xs font-normal hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setValue(chip)
                textareaRef.current?.focus()
              }}
            >
              {chip}
            </Button>
          ))}
        </div>
      )}

      {/* input row */}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <Textarea
          ref={textareaRef}
          value={value}
          rows={1}
          dir="rtl"
          placeholder="رسالة إلى وكيل…"
          aria-label="رسالة إلى وكيل"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-[44px] max-h-32 flex-1 resize-none rounded-2xl px-4 py-2.5 text-[15px] leading-6 focus-visible:border-[var(--wakil-amber)]"
        />

        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 rounded-full text-muted-foreground"
          aria-label="تسجيل صوتي لرسالتك"
          title={onVoiceClick ? undefined : 'الصوت جاي قريب'}
          disabled={!onVoiceClick}
          onClick={() => onVoiceClick?.()}
        >
          <Mic className="size-5" aria-hidden="true" />
        </Button>

        <Button
          type="submit"
          className="press size-11 shrink-0 rounded-full"
          aria-label="إرسال الرسالة"
          disabled={!canSend}
        >
          {disabled ? (
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowUp className="size-5" aria-hidden="true" />
          )}
        </Button>
      </form>
    </div>
  )
}
