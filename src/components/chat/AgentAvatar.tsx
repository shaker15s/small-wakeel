'use client'

// وكيل — Living AgentAvatar 2.0 (أيقونة وكيل التفاعلية الحية متعددة الحالات)
// Features After-Effects-grade spring physics, mouse-reactive pupil tracking,
// warm hover smile + playful head nod with procedural sound chime, and distinct
// animated states: idle, thinking, listening, calculating, analyzing_tools,
// replying, writing, searching, executing, success, and error.

import { useState, useRef, useCallback, useEffect } from 'react'
import { motion } from 'framer-motion'
import { sfx } from '@/lib/sound-effects'

export type AgentState =
  | 'idle'
  | 'thinking'
  | 'searching'
  | 'executing'
  | 'writing'
  | 'listening'
  | 'calculating'
  | 'analyzing_tools'
  | 'replying'
  | 'success'
  | 'error'

const SIZE_PX: Record<'sm' | 'md' | 'lg' | 'xl', number> = {
  sm: 28,
  md: 40,
  lg: 58,
  xl: 76,
}

export const STATE_LABEL_AR: Record<AgentState, string> = {
  idle: 'مستعد لخدمتك',
  thinking: 'بيفكر في طلبك',
  searching: 'بيبحث في السجلات والويب',
  executing: 'بينفذ العملية',
  writing: 'بيكتب الرد',
  listening: 'بيسمعك بتركيز',
  calculating: 'بيحسب الأرقام بالقرش',
  analyzing_tools: 'بيحلل ويبني الأدوات',
  replying: 'بيرد عليك',
  success: 'تم بنجاح',
  error: 'تنبيه',
}

const ANTENNA_ON: readonly AgentState[] = [
  'thinking',
  'searching',
  'executing',
  'writing',
  'listening',
  'calculating',
  'analyzing_tools',
  'replying',
]

export function AgentAvatar({
  state,
  size = 'md',
  interactive = true,
  showStatusPill = false,
}: {
  state: AgentState
  size?: 'sm' | 'md' | 'lg' | 'xl'
  interactive?: boolean
  showStatusPill?: boolean
}) {
  const px = SIZE_PX[size]
  const [hovered, setHovered] = useState(false)
  const [lookOffset, setLookOffset] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLSpanElement>(null)

  const handleMouseEnter = useCallback(() => {
    if (!interactive) return
    setHovered(true)
    sfx.playAvatarSmile()
  }, [interactive])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLSpanElement>) => {
      if (!interactive || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dx = Math.max(-2.6, Math.min(2.6, ((e.clientX - cx) / (rect.width || 40)) * 4))
      const dy = Math.max(-2.2, Math.min(2.2, ((e.clientY - cy) / (rect.height || 40)) * 3.5))
      setLookOffset({ x: dx, y: dy })
    },
    [interactive],
  )

  const handleMouseLeave = useCallback(() => {
    setHovered(false)
    setLookOffset({ x: 0, y: 0 })
  }, [])

  const antennaActive = ANTENNA_ON.includes(state) || hovered
  const effectiveState: AgentState = hovered && state === 'idle' ? 'success' : state

  // «Codex-pets» behavior: the agent JUMPS with joy the moment it starts
  // working (idle → any active state), and blinks while at rest.
  const prevStateRef = useRef<AgentState>(state)
  const [jumpNonce, setJumpNonce] = useState(0)
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = state
    if (prev === 'idle' && state !== 'idle' && interactive) setJumpNonce((n) => n + 1)
  }, [state, interactive])
  const blinking = interactive && (state === 'idle' || state === 'thinking' || state === 'searching')

  // Dynamic glow color per state
  const auraColor =
    state === 'analyzing_tools' || state === 'executing'
      ? 'rgba(16, 185, 129, 0.28)'
      : state === 'calculating'
        ? 'rgba(217, 119, 6, 0.32)'
        : state === 'listening'
          ? 'rgba(139, 92, 246, 0.32)'
          : state === 'thinking' || state === 'searching'
            ? 'rgba(217, 119, 6, 0.26)'
            : hovered
              ? 'rgba(217, 119, 6, 0.25)'
              : 'transparent'

  return (
    <span className="inline-flex flex-col items-center gap-1.5 select-none">
      <motion.span
        ref={containerRef}
        role="img"
        aria-label={`وكيل — ${STATE_LABEL_AR[state]}`}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        animate={
          hovered
            ? {
                rotate: [0, -8, 7, -4, 2, 0],
                y: [0, -3, 0],
                scale: 1.09,
              }
            : state === 'thinking' || state === 'analyzing_tools'
              ? {
                  y: [0, -2, 0],
                  rotate: [0, -1.5, 1.5, 0],
                  scale: 1,
                }
              : state === 'listening'
                ? {
                    scale: [1, 1.05, 1],
                    y: 0,
                    rotate: 0,
                  }
                : {
                    rotate: 0,
                    y: 0,
                    scale: 1,
                  }
        }
        transition={
          hovered
            ? {
                rotate: { duration: 0.65, ease: 'easeInOut' },
                y: { duration: 0.4, ease: 'easeOut' },
                scale: { type: 'spring', stiffness: 420, damping: 18 },
              }
            : state === 'thinking' || state === 'analyzing_tools' || state === 'listening'
              ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
              : { type: 'spring', stiffness: 360, damping: 24 }
        }
        className="relative inline-block shrink-0 leading-none cursor-pointer"
        style={{
          width: px,
          height: px,
          filter: auraColor !== 'transparent' ? `drop-shadow(0 0 10px ${auraColor})` : undefined,
        }}
      >
        <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">
          <motion.g
            key={jumpNonce}
            initial={jumpNonce > 0 ? { y: 0 } : false}
            animate={jumpNonce > 0 ? { y: [0, -5.5, 1.5, 0] } : { y: 0 }}
            transition={{ duration: 0.55, times: [0, 0.35, 0.62, 1], ease: 'easeOut' }}
          >
          {/* Outer orbital ring when thinking, analyzing tools, or listening */}
          {(state === 'thinking' || state === 'analyzing_tools' || state === 'calculating' || state === 'listening') && (
            <circle
              cx="32"
              cy="37"
              r="29.5"
              fill="none"
              stroke={
                state === 'analyzing_tools'
                  ? 'var(--success)'
                  : state === 'listening'
                    ? 'var(--wakil-teal)'
                    : 'var(--wakil-amber)'
              }
              strokeWidth="1.4"
              strokeDasharray={state === 'calculating' ? '3 3' : '8 6'}
              opacity="0.55"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 32 37"
                to="360 32 37"
                dur={state === 'calculating' ? '3s' : '4.5s'}
                repeatCount="indefinite"
              />
            </circle>
          )}

          {/* Listening acoustic ripple ring */}
          {state === 'listening' && (
            <circle cx="32" cy="37" r="27" fill="none" stroke="var(--wakil-teal)" strokeWidth="1.5" opacity="0.4">
              <animate attributeName="r" values="25;31;25" dur="1.4s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;0.05;0.6" dur="1.4s" repeatCount="indefinite" />
            </circle>
          )}

          {/* Antenna (waves while the agent works or when hovered) */}
          <g
            className={antennaActive ? 'avatar-antenna-active' : undefined}
            style={{ transformBox: 'fill-box' }}
          >
            <line
              x1="32"
              y1="17"
              x2="32"
              y2="9"
              stroke="var(--wakil-navy)"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <circle
              cx="32"
              cy="6.2"
              r={hovered ? '4.4' : '3.8'}
              fill={
                state === 'analyzing_tools'
                  ? 'var(--success)'
                  : state === 'listening'
                    ? 'var(--wakil-teal)'
                    : 'var(--wakil-amber)'
              }
            />
            {(antennaActive || hovered) && (
              <circle
                cx="32"
                cy="6.2"
                r="6.2"
                fill="none"
                stroke="var(--wakil-amber)"
                strokeWidth="1.2"
                opacity="0.5"
              >
                <animate attributeName="r" values="4;7.5;4" dur="1.2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.7;0;0.7" dur="1.2s" repeatCount="indefinite" />
              </circle>
            )}
          </g>

          {/* Ears — pulse when listening */}
          <rect
            x={state === 'listening' ? '1.8' : '2.8'}
            y="30.5"
            width="4.4"
            height="13"
            rx="2.2"
            fill={state === 'listening' ? 'var(--wakil-amber)' : 'var(--wakil-navy)'}
          />
          <rect
            x={state === 'listening' ? '57.8' : '56.8'}
            y="30.5"
            width="4.4"
            height="13"
            rx="2.2"
            fill={state === 'listening' ? 'var(--wakil-amber)' : 'var(--wakil-navy)'}
          />

          {/* Head */}
          <rect x="7" y="16" width="50" height="46" rx="15" fill="var(--wakil-navy)" />

          {/* Subtle inner visor frame */}
          <rect
            x="10.5"
            y="21"
            width="43"
            height="33"
            rx="11"
            fill="none"
            stroke="var(--background)"
            strokeOpacity="0.12"
            strokeWidth="1"
          />

          {/* Cheeks (blush) — brighter warm glow when hovered or happy */}
          <circle
            cx="16.5"
            cy="39.5"
            r={hovered ? '3.1' : '2.4'}
            fill="var(--wakil-amber)"
            opacity={state === 'error' ? 0.15 : hovered || state === 'success' ? 0.75 : 0.42}
          />
          <circle
            cx="47.5"
            cy="39.5"
            r={hovered ? '3.1' : '2.4'}
            fill="var(--wakil-amber)"
            opacity={state === 'error' ? 0.15 : hovered || state === 'success' ? 0.75 : 0.42}
          />

          <g className={blinking ? 'avatar-blink' : undefined}>
            <Eyes state={effectiveState} hovered={hovered} lookOffset={lookOffset} />
          </g>
          <Mouth state={effectiveState} hovered={hovered} />
          <StateBadge state={state} hovered={hovered} />
          </motion.g>
        </svg>
      </motion.span>

      {showStatusPill && (
        <motion.span
          key={state + (hovered ? '-hover' : '')}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-md border border-border/70 bg-card/90 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground shadow-2xs"
        >
          {hovered && state === 'idle' ? 'أهلاً يا ريس! 😊' : STATE_LABEL_AR[state]}
        </motion.span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Face parts
// ---------------------------------------------------------------------------

function Eyes({
  state,
  hovered,
  lookOffset,
}: {
  state: AgentState
  hovered: boolean
  lookOffset: { x: number; y: number }
}) {
  const fill = 'var(--background)'

  if (hovered || state === 'success') {
    // Warm happy smiling eyes ^ ^
    return (
      <g stroke={fill} strokeWidth="3" strokeLinecap="round" fill="none">
        <path d="M19.5 34.5 q4.5 -6.5 9 0" />
        <path d="M35.5 34.5 q4.5 -6.5 9 0" />
      </g>
    )
  }

  switch (state) {
    case 'error':
      return (
        <g stroke={fill} strokeWidth="3" strokeLinecap="round">
          <line x1="20.5" y1="34" x2="27.5" y2="34" />
          <line x1="36.5" y1="34" x2="43.5" y2="34" />
        </g>
      )
    case 'searching':
      // Scanning left/right upward
      return (
        <g fill={fill}>
          <circle cx="24" cy="30.5" r="3.5">
            <animate attributeName="cx" values="22.5;25.5;22.5" dur="1.4s" repeatCount="indefinite" />
          </circle>
          <circle cx="40" cy="30.5" r="3.5">
            <animate attributeName="cx" values="38.5;41.5;38.5" dur="1.4s" repeatCount="indefinite" />
          </circle>
        </g>
      )
    case 'calculating':
      // Digital calculation bars in the eyes
      return (
        <g fill="var(--wakil-amber)">
          <rect x="20.5" y="30.5" width="7" height="6" rx="1.8" fill={fill} />
          <rect x="36.5" y="30.5" width="7" height="6" rx="1.8" fill={fill} />
          <circle cx="24" cy="33.5" r="1.6" fill="var(--wakil-amber)">
            <animate attributeName="cx" values="22.5;25.5;22.5" dur="0.7s" repeatCount="indefinite" />
          </circle>
          <circle cx="40" cy="33.5" r="1.6" fill="var(--wakil-amber)">
            <animate attributeName="cx" values="38.5;41.5;38.5" dur="0.7s" repeatCount="indefinite" />
          </circle>
        </g>
      )
    case 'analyzing_tools':
    case 'executing':
      // Focused emerald-tinted precision eyes
      return (
        <g fill={fill}>
          <ellipse cx="24" cy="33.5" rx="4.2" ry="3.1" />
          <ellipse cx="40" cy="33.5" rx="4.2" ry="3.1" />
          <circle cx="24" cy="33.5" r="1.5" fill="var(--wakil-amber)" />
          <circle cx="40" cy="33.5" r="1.5" fill="var(--wakil-amber)" />
        </g>
      )
    case 'writing':
    case 'replying':
      // Expressive attentive eyes
      return (
        <g fill={fill}>
          <circle cx={24 + lookOffset.x} cy={35 + lookOffset.y} r="3.6" />
          <circle cx={40 + lookOffset.x} cy={35 + lookOffset.y} r="3.6" />
        </g>
      )
    case 'listening':
      // Wide attentive eyes
      return (
        <g fill={fill}>
          <circle cx="24" cy="33.5" r="4.3" />
          <circle cx="40" cy="33.5" r="4.3" />
          <circle cx="25.2" cy="32.3" r="1.3" fill="var(--wakil-teal)" />
          <circle cx="41.2" cy="32.3" r="1.3" fill="var(--wakil-teal)" />
        </g>
      )
    case 'thinking':
      return (
        <g fill={fill}>
          <circle cx="24" cy="32.5" r="4" className="thinking-dot" />
          <circle cx="40" cy="32.5" r="4" className="thinking-dot" />
        </g>
      )
    default:
      return (
        <g fill={fill}>
          <circle cx={24 + lookOffset.x} cy={34 + lookOffset.y} r="4" />
          <circle cx={40 + lookOffset.x} cy={34 + lookOffset.y} r="4" />
          <circle cx={25.2 + lookOffset.x * 1.1} cy={32.7 + lookOffset.y * 1.1} r="1.2" fill="var(--wakil-amber)" opacity="0.85" />
          <circle cx={41.2 + lookOffset.x * 1.1} cy={32.7 + lookOffset.y * 1.1} r="1.2" fill="var(--wakil-amber)" opacity="0.85" />
        </g>
      )
  }
}

function Mouth({ state, hovered }: { state: AgentState; hovered: boolean }) {
  const stroke = 'var(--background)'

  if (hovered || state === 'success') {
    // Big warm D-shaped or curved smile
    return (
      <path
        d="M25 42.5 q7 8.5 14 0"
        stroke={stroke}
        strokeWidth="2.8"
        strokeLinecap="round"
        fill="none"
      />
    )
  }

  if (state === 'replying' || state === 'writing') {
    // Animated speaking mouth
    return (
      <ellipse cx="32" cy="44.5" rx="4.5" ry="2.8" fill={stroke}>
        <animate attributeName="ry" values="1.6;3.6;1.8;3.2;1.6" dur="0.55s" repeatCount="indefinite" />
        <animate attributeName="rx" values="4.2;5.2;3.8;4.8;4.2" dur="0.55s" repeatCount="indefinite" />
      </ellipse>
    )
  }

  if (state === 'listening') {
    // Attentive wave mouth
    return (
      <g stroke={stroke} strokeWidth="2.2" strokeLinecap="round" fill="none">
        <path d="M26 44.5 q3 -3 6 0 t6 0">
          <animate
            attributeName="d"
            values="M26 44.5 q3 -3 6 0 t6 0;M26 44.5 q3 3 6 0 t6 0;M26 44.5 q3 -3 6 0 t6 0"
            dur="0.8s"
            repeatCount="indefinite"
          />
        </path>
      </g>
    )
  }

  if (state === 'calculating') {
    // Focused ledger line with scanning dot
    return (
      <g>
        <rect x="25" y="43.5" width="14" height="2.6" rx="1.3" fill={stroke} opacity="0.85" />
        <circle cx="28" cy="44.8" r="1.8" fill="var(--wakil-amber)">
          <animate attributeName="cx" values="26.5;37.5;26.5" dur="0.9s" repeatCount="indefinite" />
        </circle>
      </g>
    )
  }

  if (state === 'thinking' || state === 'searching' || state === 'analyzing_tools') {
    // Concentrating «o»
    return (
      <circle cx="32" cy="45" r="2.7" fill={stroke}>
        <animate attributeName="r" values="2.2;3.1;2.2" dur="1.2s" repeatCount="indefinite" />
      </circle>
    )
  }

  if (state === 'error') {
    return <path d="M28 45.5 h8" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" fill="none" />
  }

  return (
    <path
      d="M27.2 43.8 q4.8 4.4 9.6 0"
      stroke={stroke}
      strokeWidth="2.5"
      strokeLinecap="round"
      fill="none"
    />
  )
}

// ---------------------------------------------------------------------------
// Status badge (bottom-right corner bubble)
// ---------------------------------------------------------------------------

function BadgeBg() {
  return <circle cx="49.5" cy="49.5" r="8.8" fill="var(--card)" stroke="var(--border)" strokeWidth="1.5" />
}

function StateBadge({ state, hovered }: { state: AgentState; hovered: boolean }) {
  if (hovered && state === 'idle') {
    // Warm sparkle heart/star badge on hover
    return (
      <g>
        <BadgeBg />
        <path
          d="M49.5 45.2 L50.7 48.2 L53.8 49.5 L50.7 50.8 L49.5 53.8 L48.3 50.8 L45.2 49.5 L48.3 48.2 Z"
          fill="var(--wakil-amber)"
        />
      </g>
    )
  }

  switch (state) {
    case 'thinking':
      // Orbiting thought nodes
      return (
        <g>
          <BadgeBg />
          <circle cx="47.2" cy="49.5" r="1.4" fill="var(--wakil-amber)">
            <animate attributeName="opacity" values="0.3;1;0.3" dur="0.9s" begin="0s" repeatCount="indefinite" />
          </circle>
          <circle cx="49.8" cy="49.5" r="1.4" fill="var(--wakil-amber)">
            <animate attributeName="opacity" values="0.3;1;0.3" dur="0.9s" begin="0.3s" repeatCount="indefinite" />
          </circle>
          <circle cx="52.4" cy="49.5" r="1.4" fill="var(--wakil-amber)">
            <animate attributeName="opacity" values="0.3;1;0.3" dur="0.9s" begin="0.6s" repeatCount="indefinite" />
          </circle>
        </g>
      )
    case 'searching':
      // Magnifier
      return (
        <g>
          <BadgeBg />
          <circle
            cx="48.2"
            cy="48.2"
            r="3.2"
            fill="none"
            stroke="var(--wakil-teal)"
            strokeWidth="1.9"
          />
          <line
            x1="50.6"
            y1="50.6"
            x2="53.6"
            y2="53.6"
            stroke="var(--wakil-teal)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </g>
      )
    case 'calculating':
      // Calculator / +-= matrix badge
      return (
        <g>
          <BadgeBg />
          <rect x="45.8" y="45.8" width="7.4" height="7.4" rx="1.6" fill="none" stroke="var(--wakil-amber)" strokeWidth="1.5" />
          <line x1="47.4" y1="48.2" x2="51.6" y2="48.2" stroke="var(--wakil-amber)" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="47.4" y1="50.8" x2="51.6" y2="50.8" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      )
    case 'analyzing_tools':
    case 'executing':
      // Rotating precision gear
      return (
        <g>
          <BadgeBg />
          <g
            stroke={state === 'analyzing_tools' ? 'var(--success)' : 'var(--wakil-amber)'}
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 49.5 49.5"
              to="360 49.5 49.5"
              dur="2.4s"
              repeatCount="indefinite"
            />
            <circle cx="49.5" cy="49.5" r="2.7" fill="none" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
              <line
                key={a}
                x1="49.5"
                y1="44.2"
                x2="49.5"
                y2="42.6"
                transform={`rotate(${a} 49.5 49.5)`}
              />
            ))}
          </g>
        </g>
      )
    case 'writing':
    case 'replying':
      // Pencil / Live speech wave
      return (
        <g>
          <BadgeBg />
          <g transform="rotate(45 49.5 49.5)">
            <rect x="48.3" y="44.2" width="2.4" height="5.4" rx="0.8" fill="var(--wakil-amber)" />
            <path d="M48.3 49.6 L49.5 52.6 L50.7 49.6 Z" fill="var(--wakil-amber)" />
          </g>
        </g>
      )
    case 'listening':
      // Animated Equalizer / Sound Waves
      return (
        <g fill="var(--wakil-teal)">
          <BadgeBg />
          <rect x="44.9" y="47.8" width="1.9" height="3.4" rx="0.95">
            <animate attributeName="height" values="2.5;6;2.5" dur="0.55s" repeatCount="indefinite" />
            <animate attributeName="y" values="48.2;46.5;48.2" dur="0.55s" repeatCount="indefinite" />
          </rect>
          <rect x="48.55" y="46.4" width="1.9" height="6.2" rx="0.95">
            <animate attributeName="height" values="6.2;3;6.2" dur="0.55s" repeatCount="indefinite" />
            <animate attributeName="y" values="46.4;48;46.4" dur="0.55s" repeatCount="indefinite" />
          </rect>
          <rect x="52.2" y="47.2" width="1.9" height="4.6" rx="0.95">
            <animate attributeName="height" values="3.5;6.4;3.5" dur="0.55s" begin="0.15s" repeatCount="indefinite" />
            <animate attributeName="y" values="47.8;46.3;47.8" dur="0.55s" begin="0.15s" repeatCount="indefinite" />
          </rect>
        </g>
      )
    case 'success':
      return (
        <g>
          <BadgeBg />
          <path
            d="M46.1 49.7 L48.6 52.2 L53.1 47.3"
            fill="none"
            stroke="var(--success)"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )
    case 'error':
      return (
        <g>
          <BadgeBg />
          <g stroke="var(--destructive)" strokeWidth="2.3" strokeLinecap="round">
            <line x1="46.6" y1="46.6" x2="52.4" y2="52.4" />
            <line x1="52.4" y1="46.6" x2="46.6" y2="52.4" />
          </g>
        </g>
      )
    default:
      return null
  }
}
