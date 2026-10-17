'use client'

// وكيل — Procedural Web Audio Sound Effects Engine (مؤثرات صوتية فيزيائية ناعمة)
// Generates tactile, After-Effects-grade micro-interaction sounds using the browser's
// native Web Audio API — zero external MP3 dependencies, instant (< 1ms) response,
// and respects the user's global Mute toggle (`wakil.sound.v1`).

const SOUND_STORAGE_KEY = 'wakil.sound.v1'

class SoundEffectsEngine {
  private ctx: AudioContext | null = null
  private enabled = true

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(SOUND_STORAGE_KEY)
        if (saved !== null) {
          this.enabled = saved !== '0'
        }
      } catch {
        /* ignore */
      }
    }
  }

  public isEnabled(): boolean {
    return this.enabled
  }

  public setEnabled(val: boolean): void {
    this.enabled = val
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(SOUND_STORAGE_KEY, val ? '1' : '0')
      } catch {
        /* ignore */
      }
    }
    if (val) {
      this.playPop(520, 0.04)
    }
  }

  public toggle(): boolean {
    this.setEnabled(!this.enabled)
    return this.enabled
  }

  private getContext(): AudioContext | null {
    if (!this.enabled || typeof window === 'undefined') return null
    try {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        if (!AudioCtx) return null
        this.ctx = new AudioCtx()
      }
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {})
      }
      return this.ctx
    } catch {
      return null
    }
  }

  /** Soft warm harmonic smile chime when hovering over Wakil's avatar */
  public playAvatarSmile(): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const now = ctx.currentTime
      const osc1 = ctx.createOscillator()
      const osc2 = ctx.createOscillator()
      const gain = ctx.createGain()

      osc1.type = 'sine'
      osc2.type = 'triangle'
      osc1.frequency.setValueAtTime(523.25, now) // C5
      osc1.frequency.exponentialRampToValueAtTime(659.25, now + 0.11) // E5
      osc2.frequency.setValueAtTime(783.99, now + 0.04) // G5

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.035, now + 0.025)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.18)

      osc1.connect(gain)
      osc2.connect(gain)
      gain.connect(ctx.destination)

      osc1.start(now)
      osc2.start(now + 0.04)
      osc1.stop(now + 0.19)
      osc2.stop(now + 0.19)
    } catch {
      /* ignore audio unlock errors */
    }
  }

  /** Elastic bowstring tension sound when pressing/drawing the send button */
  public playBowDraw(): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'triangle'
      osc.frequency.setValueAtTime(240, now)
      osc.frequency.exponentialRampToValueAtTime(165, now + 0.09)

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.03, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now)
      osc.stop(now + 0.1)
    } catch {
      /* ignore */
    }
  }

  /** Bow & Arrow release: elastic string snap + upward aerodynamic whoosh */
  public playArrowLaunch(): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const shimmer = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      shimmer.type = 'triangle'

      // Upward bow release sweep
      osc.frequency.setValueAtTime(220, now)
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.14)

      shimmer.frequency.setValueAtTime(440, now + 0.03)
      shimmer.frequency.exponentialRampToValueAtTime(1320, now + 0.16)

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.055, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.18)

      osc.connect(gain)
      shimmer.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now)
      shimmer.start(now + 0.03)
      osc.stop(now + 0.19)
      shimmer.stop(now + 0.19)
    } catch {
      /* ignore */
    }
  }

  /** Subtle orbital thinking pulse when Wakil starts analyzing or reasoning */
  public playThinkingPulse(): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(349.23, now) // F4
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.12) // A4

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.022, now + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.14)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now)
      osc.stop(now + 0.15)
    } catch {
      /* ignore */
    }
  }

  /** Staggered card reveal pop */
  public playCardReveal(index = 0): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const delay = Math.min(index * 0.055, 0.25)
      const now = ctx.currentTime + delay
      const baseFreq = 420 + Math.min(index * 45, 220)

      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(baseFreq, now)
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.35, now + 0.075)

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.032, now + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.09)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now)
      osc.stop(now + 0.095)
    } catch {
      /* ignore */
    }
  }

  /** 3D Model Switcher orbital rotation click + harmonic lock */
  public playModelSwitch(): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'triangle'
      osc.frequency.setValueAtTime(587.33, now) // D5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.09) // A5

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.04, now + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.11)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now)
      osc.stop(now + 0.12)
    } catch {
      /* ignore */
    }
  }

  /** Triumphant chord when a new Plugin/Tool is synthesized or an operation is verified */
  public playSuccessChord(): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const now = ctx.currentTime
      const notes = [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        const start = now + i * 0.045

        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, start)

        gain.gain.setValueAtTime(0.001, start)
        gain.gain.linearRampToValueAtTime(0.03, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0008, start + 0.24)

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.start(start)
        osc.stop(start + 0.25)
      })
    } catch {
      /* ignore */
    }
  }

  /** Subtle keystroke / step tick for onboarding & live scanner */
  public playPop(freq = 480, volume = 0.025): void {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now)
      osc.frequency.exponentialRampToValueAtTime(freq * 1.2, now + 0.045)

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(volume, now + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.055)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now)
      osc.stop(now + 0.06)
    } catch {
      /* ignore */
    }
  }
}

export const sfx = new SoundEffectsEngine()
