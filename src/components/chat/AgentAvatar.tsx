'use client'

// وكيل — the agent mascot: a friendly little robot (Duolingo-owl energy).
// Pure presentational, zero hooks. All colors come from CSS tokens so the
// face stays legible in light AND dark mode (head flips to light navy in dark).

export type AgentState =
  | 'idle'
  | 'thinking'
  | 'searching'
  | 'executing'
  | 'writing'
  | 'listening'
  | 'success'
  | 'error'

const SIZE_PX: Record<'sm' | 'md' | 'lg', number> = { sm: 28, md: 40, lg: 56 }

const STATE_LABEL_AR: Record<AgentState, string> = {
  idle: 'خامل',
  thinking: 'يفكر',
  searching: 'يبحث',
  executing: 'ينفذ',
  writing: 'يكتب',
  listening: 'يستمع',
  success: 'نجح',
  error: 'خطأ',
}

/** States where the antenna waves (work in progress). */
const ANTENNA_ON: readonly AgentState[] = ['thinking', 'searching', 'executing', 'writing', 'listening']

export function AgentAvatar({ state, size = 'md' }: { state: AgentState; size?: 'sm' | 'md' | 'lg' }) {
  const px = SIZE_PX[size]
  const antennaActive = ANTENNA_ON.includes(state)

  return (
    <span
      role="img"
      aria-label={`وكيل — ${STATE_LABEL_AR[state]}`}
      className="inline-block shrink-0 select-none leading-none"
      style={{ width: px, height: px }}
    >
      <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">
        {/* antenna (waves while the agent works) */}
        <g
          className={antennaActive ? 'avatar-antenna-active' : undefined}
          style={{ transformBox: 'fill-box' }}
        >
          <line
            x1="32"
            y1="17"
            x2="32"
            y2="9.5"
            stroke="var(--wakil-navy)"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="32" cy="6.5" r="3.8" fill="var(--wakil-amber)" />
        </g>

        {/* ears */}
        <rect x="2.8" y="31" width="4.2" height="12" rx="2.1" fill="var(--wakil-navy)" />
        <rect x="57" y="31" width="4.2" height="12" rx="2.1" fill="var(--wakil-navy)" />

        {/* head */}
        <rect x="7" y="16" width="50" height="46" rx="15" fill="var(--wakil-navy)" />

        {/* cheeks (blush) — dim when grumpy */}
        <circle
          cx="16.5"
          cy="39"
          r="2.4"
          fill="var(--wakil-amber)"
          opacity={state === 'error' ? 0.15 : 0.4}
        />
        <circle
          cx="47.5"
          cy="39"
          r="2.4"
          fill="var(--wakil-amber)"
          opacity={state === 'error' ? 0.15 : 0.4}
        />

        <Eyes state={state} />
        <Mouth state={state} />
        <StateBadge state={state} />
      </svg>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Face parts
// ---------------------------------------------------------------------------

function Eyes({ state }: { state: AgentState }) {
  const fill = 'var(--background)'

  switch (state) {
    case 'success':
      // happy closed eyes ^ ^
      return (
        <g stroke={fill} strokeWidth="3" strokeLinecap="round" fill="none">
          <path d="M20 34 q4 -6 8 0" />
          <path d="M36 34 q4 -6 8 0" />
        </g>
      )
    case 'error':
      // flat, unimpressed eyes
      return (
        <g stroke={fill} strokeWidth="3" strokeLinecap="round">
          <line x1="21" y1="34" x2="27" y2="34" />
          <line x1="37" y1="34" x2="43" y2="34" />
        </g>
      )
    case 'searching':
      // looking up
      return (
        <g fill={fill}>
          <circle cx="24" cy="30.5" r="3.4" />
          <circle cx="40" cy="30.5" r="3.4" />
        </g>
      )
    case 'writing':
      // looking down at the paper
      return (
        <g fill={fill}>
          <circle cx="24" cy="36.5" r="3.4" />
          <circle cx="40" cy="36.5" r="3.4" />
        </g>
      )
    case 'executing':
      // focused, slightly narrowed
      return (
        <g fill={fill}>
          <ellipse cx="24" cy="34" rx="4" ry="2.9" />
          <ellipse cx="40" cy="34" rx="4" ry="2.9" />
        </g>
      )
    case 'thinking':
      // pulsing dots (uses .thinking-dot from globals.css)
      return (
        <g fill={fill}>
          <circle cx="24" cy="34" r="4" className="thinking-dot" />
          <circle cx="40" cy="34" r="4" className="thinking-dot" />
        </g>
      )
    default:
      return (
        <g fill={fill}>
          <circle cx="24" cy="34" r="4" />
          <circle cx="40" cy="34" r="4" />
        </g>
      )
  }
}

function Mouth({ state }: { state: AgentState }) {
  const stroke = 'var(--background)'

  if (state === 'thinking' || state === 'searching') {
    // little «o» — concentrating
    return <circle cx="32" cy="45" r="2.6" fill={stroke} />
  }
  if (state === 'success') {
    return (
      <path
        d="M26 43 q6 7 12 0"
        stroke={stroke}
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
    )
  }
  if (state === 'error') {
    return <path d="M28 45.5 h8" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" fill="none" />
  }
  return (
    <path
      d="M27.5 44 q4.5 4 9 0"
      stroke={stroke}
      strokeWidth="2.4"
      strokeLinecap="round"
      fill="none"
    />
  )
}

// ---------------------------------------------------------------------------
// Status badge (bottom-right corner bubble)
// ---------------------------------------------------------------------------

function BadgeBg() {
  return <circle cx="49.5" cy="49.5" r="8.4" fill="var(--card)" stroke="var(--border)" strokeWidth="1.5" />
}

function StateBadge({ state }: { state: AgentState }) {
  switch (state) {
    case 'searching':
      // magnifier
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
    case 'executing':
      // gear
      return (
        <g>
          <BadgeBg />
          <g stroke="var(--wakil-amber)" strokeWidth="1.7" strokeLinecap="round">
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
      // pencil
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
      // equalizer / sound waves
      return (
        <g fill="var(--wakil-teal)">
          <BadgeBg />
          <rect x="44.9" y="47.8" width="1.9" height="3.4" rx="0.95" />
          <rect x="48.55" y="46.4" width="1.9" height="6.2" rx="0.95" />
          <rect x="52.2" y="47.2" width="1.9" height="4.6" rx="0.95" />
        </g>
      )
    case 'success':
      // green check
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
      // red ✕
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
