'use client'

// وكيل — AmbientBackground: the living layer behind the whole app.
//
// Three brand-light orbs (gold / navy / teal) drift on slow independent
// orbits and lean toward the cursor with inertia — the screen feels like
// a lit room, not a painted wall. Performance contract:
//   • orbs are pre-softened radial gradients (NO blur filters — those
//     re-rasterize every frame and stutter on mid-range Android)
//   • parallax is a single rAF lerp writing transform on three elements
//     (compositor-only), ~0.1ms/frame
//   • prefers-reduced-motion → static, no listener at all
//   • pointer: coarse (touch) → no parallax (finger is the content, not
//     the decor); the drift keeps the background alive

import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'

const ORBS = [
  { className: 'orb-gold', depth: 1.0 },
  { className: 'orb-navy', depth: 0.65 },
  { className: 'orb-teal', depth: 0.4 },
] as const

export function AmbientBackground() {
  const reduced = useReducedMotion()
  const refs = useRef<Array<HTMLDivElement | null>>([])

  useEffect(() => {
    if (reduced) return
    if (window.matchMedia?.('(pointer: coarse)').matches) return

    let raf = 0
    let tx = 0
    let ty = 0 // eased (current)
    let cx = 0
    let cy = 0 // cursor target (-1..1)
    let active = true

    const onMove = (e: PointerEvent) => {
      cx = (e.clientX / window.innerWidth) * 2 - 1
      cy = (e.clientY / window.innerHeight) * 2 - 1
    }

    const tick = () => {
      if (!active) return
      // critically-damped-ish lerp: snappy start, long settle
      tx += (cx - tx) * 0.045
      ty += (cy - ty) * 0.045
      refs.current.forEach((el, i) => {
        if (!el) return
        const depth = ORBS[i].depth
        el.style.transform = `translate3d(${(tx * 26 * depth).toFixed(2)}px, ${(ty * 18 * depth).toFixed(2)}px, 0)`
      })
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    raf = requestAnimationFrame(tick)
    return () => {
      active = false
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [reduced])

  return (
    <div aria-hidden className="ambient-bg" role="presentation">
      {ORBS.map((orb, i) => (
        <div
          key={orb.className}
          ref={(el) => {
            refs.current[i] = el
          }}
          className={`ambient-orb ${orb.className}`}
        />
      ))}
    </div>
  )
}
