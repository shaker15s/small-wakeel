'use client'

// Calm, evidence-led progress: no random claims about checking stock/cash.
import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Check, Loader2 } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import type { ThinkingStep } from '@/lib/types'

export function ThinkingIndicator({ steps, waiting = false, showAvatar = true }: {
  steps?: ThinkingStep[] | null; waiting?: boolean; showAvatar?: boolean
}) {
  const reduced = useReducedMotion()
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const active = [...(steps ?? [])].reverse().find((s) => s.state === 'active')
  const completed = (steps ?? []).filter((s) => s.state === 'done').length
  const label = active?.label ?? (waiting ? 'وصل طلبك — بجهّز الرد' : 'بجهّز الرد ليك')
  return (
    <div className="flex min-w-0 items-start gap-3" role="status" aria-live="polite" aria-label="وكيل بيجهّز الرد" aria-busy="true">
      {showAvatar && <AgentAvatar state="thinking" size="sm" />}
      <div className="glass-strong relative min-w-0 overflow-hidden rounded-2xl border border-amber-500/20 px-4 py-3 shadow-sm">
        <span className="pointer-events-none absolute inset-y-3 start-0 w-0.5 rounded-full bg-gradient-to-b from-amber-400 to-teal-500" aria-hidden="true" />
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1" aria-hidden="true">
            {[0, 1, 2].map((i) => <motion.span key={i} className="size-1.5 rounded-full bg-wakil-amber" animate={reduced ? { opacity: 0.7 } : { opacity: [0.3, 1, 0.3], y: [0, -2, 0] }} transition={{ duration: 1.3, delay: i * 0.18, repeat: reduced ? 0 : Infinity }} />)}
          </span>
          <span className="text-xs font-medium leading-6 sm:text-sm">{label}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground" aria-hidden="true">
          {completed > 0 ? <><Check className="size-3 text-teal-600" /><span>{new Intl.NumberFormat('ar-EG').format(completed)} خطوات اتنفذت</span></> : <><Loader2 className="size-3 animate-spin motion-reduce:animate-none" /><span>النتيجة هتظهر هنا</span></>}
          {elapsed >= 3 && <span className="num ms-auto tabular-nums">{new Intl.NumberFormat('ar-EG').format(elapsed)}ث</span>}
        </div>
        {elapsed >= 12 && <p className="mt-2 max-w-64 text-[11px] leading-5 text-muted-foreground">الرد بياخد وقت أطول شوية. مش محتاج تبعت طلبك تاني.</p>}
      </div>
    </div>
  )
}
