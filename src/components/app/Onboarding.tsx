'use client'

// وكيل — Cinematic Live Multimodal Onboarding (جلسة التأسيس الاستكشافية الحية)
//
// Combines After-Effects-grade motion graphics, mouse-reactive aurora borders,
// procedural Web Audio SFX, and a Live Gemini Multimodal Discovery Session:
// - Stage 0: Owner Name & Business Name with live reactive thinking/typing studio box
//            (plus quick jump to existing preset businesses).
// - Stage 1: Smart System Branching («عندك سيستم جاهز على الكمبيوتر» vs
//            «معنديش سيستم / شغال بالكشكول والدفتر — ابنيلي السيستم والأدوات»).
// - Stage 2: Live Multimodal Discovery Session powered by Gemini:
//            • Live Camera Inspector (show your notebook/كشكول, invoices, or store shelves)
//            • Live Arabic Voice Microphone + Photo Upload + Interactive Chat
//            • Real-time extraction of catalog items, prices, parties, and custom plugins
//            • 1-Click full ERP + PluginRegistry + Vector Memory provisioning.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Boxes,
  Camera,
  CameraOff,
  Check,
  Cpu,
  Dumbbell,
  ImagePlus,
  Loader2,
  Mic,
  MicOff,
  MonitorCheck,
  NotebookPen,
  Pill,
  Plus,
  ShoppingBasket,
  Sparkles,
  Trash2,
  Users,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react'
import type { BusinessLite } from '@/lib/types'
import { getVertical } from '@/lib/verticals'
import { AgentAvatar, type AgentState } from '@/components/chat/AgentAvatar'
import { Button } from '@/components/ui/button'
import { QUERY_KEYS, useWakil } from '@/lib/store'
import { sfx } from '@/lib/sound-effects'
import { cn } from '@/lib/utils'
import type {
  ExtractedItemSpec,
  ExtractedPartySpec,
  SuggestedPluginSpec,
} from '@/app/api/onboarding/analyze/route'

const VERTICAL_ICONS = {
  basket: ShoppingBasket,
  dumbbell: Dumbbell,
  pill: Pill,
  sparkle: Sparkles,
} as const

const BUSINESS_TYPES = [
  { key: 'supermarket', label: 'سوبر ماركت وبقالة' },
  { key: 'attar', label: 'عطارة وبن وتوابل' },
  { key: 'pharmacy', label: 'صيدلية ومستلزمات طبية' },
  { key: 'restaurant', label: 'مطعم أو كافيه' },
  { key: 'clothing', label: 'ملابس وأحذية وموضة' },
  { key: 'electronics', label: 'إلكترونيات وموبايلات' },
  { key: 'wholesale', label: 'تجارة جملة وتوزيع' },
  { key: 'gym', label: 'جيم ومركز رياضي' },
  { key: 'clinic', label: 'عيادة أو مركز طبي' },
] as const

export function Onboarding({
  businesses,
  onFinish,
  onPick,
}: {
  businesses: BusinessLite[]
  onFinish: () => void
  onPick: (businessId: string, userId: string) => void
}) {
  const queryClient = useQueryClient()
  const soundEnabled = useWakil((s) => s.soundEnabled)
  const toggleSound = useWakil((s) => s.toggleSound)

  // Stage 0: Identity & Business Name | Stage 1: System Question | Stage 2: Live Gemini Session
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [ownerName, setOwnerName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [businessType, setBusinessType] = useState<string>('supermarket')
  const [openingCashEgp, setOpeningCashEgp] = useState<number>(15000)
  const [hasExistingSystem, setHasExistingSystem] = useState<boolean | null>(null)

  // Reactive Avatar & Aurora Box State
  const [avatarState, setAvatarState] = useState<AgentState>('idle')
  const [mousePos, setMousePos] = useState({ x: 50, y: 50, pxX: 220, pxY: 80 })
  const studioBoxRef = useRef<HTMLDivElement>(null)

  // Stage 2: Live Multimodal Discovery Session State
  const [chatHistory, setChatHistory] = useState<{ role: 'wakil' | 'user'; text: string }[]>([
    {
      role: 'wakil',
      text: 'أنا جاهز معاك صوت وصورة وشات! افتح الكاميرا ووريني صفحة من الكشكول أو الفواتير أو أرفف المخزن، أو احكيلي بالمايك/الكتابة بتبيع إيه وبكام وهبنيلك السيستم والأدوات قدام عينك فوراً.',
    },
  ])
  const [liveInput, setLiveInput] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [provisioning, setProvisioning] = useState(false)
  const [bowState, setBowState] = useState<'idle' | 'drawing' | 'launching'>('idle')

  // Camera & Voice Inspector
  const [cameraActive, setCameraActive] = useState(false)
  const [capturedPreview, setCapturedPreview] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)

  // Live Extracted ERP Blueprint
  const [extractedItems, setExtractedItems] = useState<ExtractedItemSpec[]>([
    { name: 'لبن جهينة كامل الدسم ١ لتر', unit: 'علبة', sellPriceEgp: 45, costPriceEgp: 38, stockQty: 48, category: 'ألبان' },
    { name: 'أرز مصري فاخر ١ كيلو', unit: 'كيلو', sellPriceEgp: 35, costPriceEgp: 29, stockQty: 80, category: 'بقالة' },
  ])
  const [extractedParties, setExtractedParties] = useState<ExtractedPartySpec[]>([
    { kind: 'customer', name: 'الحاج محمود (حساب الكشكول)', balanceEgp: 450 },
  ])
  const [suggestedPlugins, setSuggestedPlugins] = useState<SuggestedPluginSpec[]>([
    {
      slug: 'plugin_inventory_optimizer',
      name: 'إدارة المخزون الذكية وتصنيف ABC',
      description: 'يراقب النواقص والأصناف الراكدة ويحسب كميات إعادة الطلب تلقائياً',
    },
    {
      slug: 'plugin_sales_velocity',
      name: 'تحليل المبيعات وسرعة الدوران',
      description: 'يرصد الأصناف الحصان الرابح وصافي الربح اليومي والأسبوعي',
    },
  ])
  const [suggestedRules, setSuggestedRules] = useState<string[]>([
    'التنبيه الفوري عند وصول أي صنف أساسي لحد الطلب',
  ])

  // Stop camera stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
    }
  }, [])

  // Handle mouse movement on the interactive studio box
  const handleBoxMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = studioBoxRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pxX = e.clientX - rect.left
    const pxY = e.clientY - rect.top
    const x = Math.round((pxX / Math.max(1, rect.width)) * 100)
    const y = Math.round((pxY / Math.max(1, rect.height)) * 100)
    setMousePos({ x, y, pxX, pxY })
  }, [])

  // Start / Stop Live Camera
  const toggleCamera = useCallback(async () => {
    if (cameraActive) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
      setCameraActive(false)
      setAvatarState('idle')
      return
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = media
      setCameraActive(true)
      setAvatarState('searching')
      sfx.playPop(620, 0.03)
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = media
          void videoRef.current.play().catch(() => {})
        }
      }, 80)
    } catch {
      setChatHistory((prev) => [
        ...prev,
        {
          role: 'wakil',
          text: 'ملقيتش صلاحية للكاميرا المباشرة حالياً — تقدر ترفع صورة الكشكول أو المخزن من زرار «رفع صورة» جنبك علطول وهحللها فوراً!',
        },
      ])
    }
  }, [cameraActive])

  // Send Multimodal Analysis Request to Gemini (`/api/onboarding/analyze`)
  const runMultimodalAnalysis = useCallback(
    async (opts: { messageText?: string; imageBase64?: string; mimeType?: string }) => {
      const msg = (opts.messageText ?? liveInput).trim()
      if (!msg && !opts.imageBase64) return

      setAnalyzing(true)
      setAvatarState(opts.imageBase64 ? 'analyzing_tools' : 'thinking')
      sfx.playThinkingPulse()

      if (msg) {
        setChatHistory((prev) => [...prev, { role: 'user', text: msg }])
        setLiveInput('')
      } else if (opts.imageBase64) {
        setChatHistory((prev) => [
          ...prev,
          { role: 'user', text: '📸 شاركت لقطة من الكاميرا / صورة الكشكول والمخزن للتحليل' },
        ])
      }

      try {
        const res = await fetch('/api/onboarding/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'analyze',
            ownerName: ownerName || 'صاحب الشغل',
            businessName: businessName || 'مشروعي',
            businessType,
            hasExistingSystem: Boolean(hasExistingSystem),
            message: msg,
            imageBase64: opts.imageBase64,
            mimeType: opts.mimeType,
          }),
        })
        const data = await res.json()
        if (data.ok) {
          if (data.detectedVertical) {
            setBusinessType(data.detectedVertical)
          }
          if (Array.isArray(data.extractedItems) && data.extractedItems.length > 0) {
            setExtractedItems((prev) => {
              const merged = [...prev]
              for (const item of data.extractedItems as ExtractedItemSpec[]) {
                if (!merged.some((m) => m.name === item.name)) {
                  merged.unshift(item)
                }
              }
              return merged.slice(0, 16)
            })
          }
          if (Array.isArray(data.extractedParties) && data.extractedParties.length > 0) {
            setExtractedParties((prev) => {
              const merged = [...prev]
              for (const p of data.extractedParties as ExtractedPartySpec[]) {
                if (!merged.some((m) => m.name === p.name)) {
                  merged.unshift(p)
                }
              }
              return merged.slice(0, 10)
            })
          }
          if (Array.isArray(data.suggestedPlugins) && data.suggestedPlugins.length > 0) {
            setSuggestedPlugins(data.suggestedPlugins)
          }
          if (Array.isArray(data.suggestedRules) && data.suggestedRules.length > 0) {
            setSuggestedRules(data.suggestedRules)
          }
          if (data.replyAr) {
            setChatHistory((prev) => [...prev, { role: 'wakil', text: data.replyAr }])
          }
          setAvatarState('success')
          sfx.playSuccessChord()
          setTimeout(() => setAvatarState('idle'), 2200)
        }
      } catch {
        setAvatarState('idle')
      } finally {
        setAnalyzing(false)
      }
    },
    [liveInput, ownerName, businessName, businessType, hasExistingSystem],
  )

  // Capture a frame from the live video feed and send to Gemini Vision
  const captureCameraFrame = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
    setCapturedPreview(dataUrl)
    sfx.playArrowLaunch()
    void runMultimodalAnalysis({
      imageBase64: dataUrl,
      mimeType: 'image/jpeg',
      messageText: liveInput.trim() || 'حلل اللقطة المباشرة دي من الكشكول أو المخزن واستخرج الأصناف والأسعار والحسابات',
    })
  }, [runMultimodalAnalysis, liveInput])

  // Upload photo of notebook / invoice / inventory
  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        if (result) {
          setCapturedPreview(result)
          void runMultimodalAnalysis({
            imageBase64: result,
            mimeType: file.type || 'image/jpeg',
            messageText: liveInput.trim() || `حلل صورة «${file.name}» واستخرج منها الأصناف والأسعار والحسابات`,
          })
        }
      }
      reader.readAsDataURL(file)
    },
    [runMultimodalAnalysis, liveInput],
  )

  // Live Arabic Voice Dictation in Onboarding
  const toggleVoice = useCallback(() => {
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop()
      setListening(false)
      setAvatarState('idle')
      return
    }
    if (typeof window === 'undefined') return
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition
    if (!SpeechRec) return
    try {
      const rec = new SpeechRec() as {
        lang: string
        continuous: boolean
        interimResults: boolean
        onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
        onerror: (() => void) | null
        onend: (() => void) | null
        start: () => void
        stop: () => void
      }
      rec.lang = 'ar-EG'
      rec.continuous = false
      rec.interimResults = true
      rec.onresult = (event) => {
        let transcript = ''
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript
        }
        if (transcript.trim()) {
          setLiveInput(transcript)
        }
      }
      rec.onerror = () => {
        setListening(false)
        setAvatarState('idle')
      }
      rec.onend = () => {
        setListening(false)
        setAvatarState('idle')
      }
      recognitionRef.current = rec
      setListening(true)
      setAvatarState('listening')
      sfx.playPop(640, 0.03)
      rec.start()
    } catch {
      setListening(false)
    }
  }, [listening])

  // Provision complete ERP system & enter workspace
  const handleProvisionAndStart = useCallback(async () => {
    setProvisioning(true)
    setAvatarState('analyzing_tools')
    sfx.playThinkingPulse()
    try {
      const res = await fetch('/api/onboarding/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'provision',
          ownerName: ownerName.trim() || 'صاحب الشغل',
          businessName: businessName.trim() || 'منشأتي الذكية',
          businessType,
          hasExistingSystem: Boolean(hasExistingSystem),
          openingCashEgp,
          items: extractedItems,
          parties: extractedParties,
          plugins: suggestedPlugins,
          rules: suggestedRules,
        }),
      })
      const data = await res.json()
      if (data.ok && data.business && data.userId) {
        sfx.playSuccessChord()
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop())
        }
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap })
        onPick(data.business.id, data.userId)
        onFinish()
        return
      }
    } catch (err) {
      console.error('[onboarding] provision failed:', err)
    } finally {
      setProvisioning(false)
    }
  }, [
    ownerName,
    businessName,
    businessType,
    hasExistingSystem,
    openingCashEgp,
    extractedItems,
    extractedParties,
    suggestedPlugins,
    suggestedRules,
    queryClient,
    onPick,
    onFinish,
  ])

  // Quick pick an existing demo business if user wants immediate preset
  const handlePickPresetBusiness = (b: BusinessLite) => {
    sfx.playSuccessChord()
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
    }
    onPick(b.id, b.users[0].id)
    onFinish()
  }

  return (
    <div
      dir="rtl"
      className="relative flex min-h-dvh flex-col overflow-x-hidden bg-gradient-to-b from-background via-background to-accent/35"
    >
      {/* Ambient studio lighting */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-28 -start-24 size-80 rounded-full bg-[var(--wakil-amber-soft)] opacity-60 blur-3xl" />
        <div className="absolute -bottom-32 -end-24 size-96 rounded-full bg-primary/10 blur-3xl" />
      </div>

      {/* Top Studio Header: Progress Steps + Sound Mute Toggle */}
      <header className="relative z-20 mx-auto flex w-full max-w-5xl items-center justify-between px-4 pt-5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <AgentAvatar state={avatarState} size="sm" />
          <div>
            <span className="block text-xs font-extrabold tracking-tight">استوديو تأسيس وكيل الحي</span>
            <span className="block text-[10px] text-muted-foreground">
              مدعوم بـ Gemini Vision & Voice + محرك الأدوات الذاتي
            </span>
          </div>
        </div>

        {/* Step indicators */}
        <div className="flex items-center gap-2" aria-label={`المرحلة ${step + 1} من 3`}>
          {[
            { idx: 0, label: '١. التعارف والنشاط' },
            { idx: 1, label: '٢. حالة السيستم' },
            { idx: 2, label: '٣. الجلسة الحية والأدوات' },
          ].map((s) => {
            const active = step === s.idx
            const done = step > s.idx
            return (
              <button
                key={s.idx}
                type="button"
                onClick={() => {
                  if (s.idx <= step || ownerName.trim() || businessName.trim()) {
                    sfx.playPop(500, 0.025)
                    setStep(s.idx as 0 | 1 | 2)
                  }
                }}
                className={cn(
                  'flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11px] font-bold transition-all',
                  active
                    ? 'border-wakil-amber bg-wakil-amber/15 text-foreground shadow-2xs'
                    : done
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-border/60 bg-card/50 text-muted-foreground',
                )}
              >
                {done ? <Check className="size-3 text-emerald-600" /> : null}
                <span className="hidden sm:inline">{s.label}</span>
                <span className="sm:hidden">{s.idx + 1}</span>
              </button>
            )
          })}
        </div>

        {/* Sound Mute / Unmute Quick Button */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            toggleSound()
            sfx.setEnabled(!soundEnabled)
          }}
          className="press h-8 gap-1.5 rounded-xl px-2.5 text-xs"
          title={soundEnabled ? 'كتم المؤثرات الصوتية' : 'تفعيل المؤثرات الصوتية'}
        >
          {soundEnabled ? (
            <>
              <Volume2 className="size-3.5 text-wakil-amber" />
              <span className="hidden sm:inline">الصوت شغّال</span>
            </>
          ) : (
            <>
              <VolumeX className="size-3.5 text-muted-foreground" />
              <span className="hidden sm:inline">صامت</span>
            </>
          )}
        </Button>
      </header>

      {/* Main Content Container */}
      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4 py-6 sm:px-6">
        {/* ===================================================================
            STAGE 0: INTERACTIVE IDENTITY & BUSINESS STUDIO BOX
           =================================================================== */}
        {step === 0 && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-center">
            {/* Right column: Reactive Motion-Graphics Identity Studio */}
            <motion.div
              ref={studioBoxRef}
              onMouseMove={handleBoxMouseMove}
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 360, damping: 26 }}
              style={{
                backgroundImage: `radial-gradient(420px circle at ${mousePos.pxX}px ${mousePos.pxY}px, rgba(217, 119, 6, 0.38), transparent 75%), radial-gradient(500px circle at ${100 - mousePos.x}% ${100 - mousePos.y}%, rgba(16, 185, 129, 0.22), transparent 80%)`,
              }}
              className="rounded-3xl p-[2px] shadow-xl lg:col-span-7"
            >
              <div className="glass-strong flex flex-col rounded-[calc(1.5rem-2px)] bg-card/95 p-6 sm:p-7">
                <div className="flex items-center gap-4">
                  <AgentAvatar state={avatarState} size="lg" showStatusPill />
                  <div className="flex-1 text-start">
                    <h1 className="text-xl font-extrabold leading-snug sm:text-2xl">
                      أهلاً بيك يا ريس! أنا «وكيل» 👋
                    </h1>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                      خلينا نتعرف في ثواني عشان أظبطلك عقلي، ذاكرتي، وأدوات شغلك على مقاسك بالظبط.
                    </p>
                  </div>
                </div>

                {/* Live Animated Thinking Status Bar */}
                <motion.div
                  key={`${ownerName.length}-${businessName.length}-${businessType}`}
                  initial={{ opacity: 0.7, scale: 0.99 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-5 flex items-center gap-2.5 rounded-2xl border border-wakil-amber/30 bg-wakil-amber/8 px-3.5 py-2.5 text-xs"
                >
                  <Sparkles className="size-4 shrink-0 text-wakil-amber animate-pulse" />
                  <span className="font-medium text-foreground">
                    {!ownerName.trim()
                      ? 'وكيل مستني يتعرف على اسمك الكريم…'
                      : !businessName.trim()
                        ? `تشرفنا يا ${ownerName}! قولّي بقى اسم مشروعك أو محلك إيه؟`
                        : `يا بركة يا ${ownerName}! بجهّز دلوقتي بيئة العمل المخصصة لـ «${businessName}»…`}
                  </span>
                </motion.div>

                {/* Inputs with reactive focus states */}
                <div className="mt-5 space-y-4">
                  <div>
                    <label className="mb-1.5 block text-xs font-bold text-foreground">
                      اسمك الكريم إيه؟ (عشان أناديك بيه في الشغل)
                    </label>
                    <input
                      type="text"
                      value={ownerName}
                      onFocus={() => setAvatarState('listening')}
                      onBlur={() => setAvatarState('idle')}
                      onChange={(e) => {
                        setOwnerName(e.target.value)
                        setAvatarState('thinking')
                        sfx.playPop(460 + (e.target.value.length % 8) * 20, 0.015)
                      }}
                      placeholder="مثال: الحاج عبد الله، أستاذ شيكو، دكتور أحمد…"
                      className="h-11 w-full rounded-xl border border-border bg-background/80 px-3.5 text-sm font-semibold transition-all focus:border-wakil-amber focus:outline-none focus:ring-2 focus:ring-wakil-amber/25"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-bold text-foreground">
                      اسم مشروعك أو محلك إيه؟
                    </label>
                    <input
                      type="text"
                      value={businessName}
                      onFocus={() => setAvatarState('calculating')}
                      onBlur={() => setAvatarState('idle')}
                      onChange={(e) => {
                        setBusinessName(e.target.value)
                        setAvatarState('calculating')
                        sfx.playPop(520 + (e.target.value.length % 8) * 20, 0.015)
                      }}
                      placeholder="مثال: عطارة البركة، سوبر ماركت النور، صيدلية الشفاء…"
                      className="h-11 w-full rounded-xl border border-border bg-background/80 px-3.5 text-sm font-semibold transition-all focus:border-wakil-amber focus:outline-none focus:ring-2 focus:ring-wakil-amber/25"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-bold text-foreground">
                      طبيعة النشاط (أو سيبها ووكيل هيلقطها من كلامك/الكاميرا)
                    </label>
                    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-3">
                      {BUSINESS_TYPES.map((bt) => {
                        const active = businessType === bt.key
                        return (
                          <button
                            key={bt.key}
                            type="button"
                            onClick={() => {
                              setBusinessType(bt.key)
                              setAvatarState('analyzing_tools')
                              sfx.playPop(580, 0.025)
                            }}
                            className={cn(
                              'press rounded-xl border px-2.5 py-2 text-start text-[11px] font-bold transition-all',
                              active
                                ? 'border-wakil-amber bg-wakil-amber/15 text-foreground ring-1 ring-wakil-amber/30'
                                : 'border-border/70 bg-background/60 text-muted-foreground hover:border-wakil-amber/40 hover:text-foreground',
                            )}
                          >
                            {bt.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>

                <Button
                  type="button"
                  onClick={() => {
                    if (!ownerName.trim()) setOwnerName('يا ريس')
                    if (!businessName.trim()) setBusinessName('منشأة النور')
                    sfx.playArrowLaunch()
                    setAvatarState('success')
                    setStep(1)
                  }}
                  className="mt-6 h-12 w-full rounded-2xl text-sm font-extrabold shadow-md shadow-primary/20 transition-transform hover:scale-[1.01] active:scale-98"
                >
                  <span>الخطوة الجاية: حالة السيستم وأدوات الشغل</span>
                  <ArrowLeft className="ms-2 size-4" />
                </Button>
              </div>
            </motion.div>

            {/* Left column: Quick Jump into Ready Demo Businesses */}
            <motion.div
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1, type: 'spring', stiffness: 360, damping: 28 }}
              className="flex flex-col gap-3 rounded-3xl border border-border/80 bg-card/85 p-5 shadow-sm lg:col-span-5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold text-foreground">
                  أو ادخل فوراً على نشاط جاهز للتجربة السريعة:
                </span>
                <span className="rounded-md bg-accent px-2 py-0.5 text-[10px] font-bold text-wakil-amber">
                  بيانات حية
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                لو حابب تجرب «وكيل» فوراً على منشأة شغّالة ببياناتها وأصنافها وعملائها بضغطة واحدة:
              </p>

              <div className="space-y-2">
                {businesses.map((b, i) => {
                  const v = getVertical(b.type)
                  const Icon = VERTICAL_ICONS[v.icon] ?? ShoppingBasket
                  return (
                    <motion.button
                      key={b.id}
                      type="button"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.12 + i * 0.04 }}
                      whileHover={{ x: -3 }}
                      onClick={() => handlePickPresetBusiness(b)}
                      className="press flex w-full items-center gap-3 rounded-2xl border border-border/80 bg-background/80 p-3 text-start transition-colors hover:border-wakil-amber"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-wakil-amber">
                        <Icon className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-extrabold">{b.name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {v.shortLabel} — {v.description}
                        </span>
                      </span>
                      <ArrowLeft className="size-4 shrink-0 text-muted-foreground" />
                    </motion.button>
                  )
                })}
              </div>
            </motion.div>
          </div>
        )}

        {/* ===================================================================
            STAGE 1: SMART SYSTEM BRANCHING («عندك سيستم ولا نبنيلك من الكشكول؟»)
           =================================================================== */}
        {step === 1 && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26 }}
            className="mx-auto flex w-full max-w-3xl flex-col items-center text-center"
          >
            <AgentAvatar state={avatarState} size="xl" showStatusPill />
            <h2 className="mt-4 text-xl font-extrabold sm:text-2xl">
              يا {ownerName || 'ريس'}، قولي وضع «{businessName || 'مشروعك'}» إيه دلوقتي؟
            </h2>
            <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground sm:text-sm">
              سواء عندك سيستم على الكمبيوتر عايزنا نتحكم فيه ونبني عليه أدوات، أو شغال بدفتر وكشكول وعايزنا نفتح الكاميرا والمايك ونبنيلك إحنا السيستم من الألف للياء:
            </p>

            <div className="mt-6 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Branch A: No System / Paper Notebook -> Live Camera & Voice Session */}
              <motion.button
                type="button"
                whileHover={{ y: -4, scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setHasExistingSystem(false)
                  setAvatarState('listening')
                  sfx.playSuccessChord()
                  setStep(2)
                  void runMultimodalAnalysis({
                    messageText: `معنديش سيستم وشغال بالكشكول في ${businessName} (${businessType}) — جهزلي الأصناف المبدئية وأدوات المتابعة الذكية`,
                  })
                }}
                className="flex flex-col items-start justify-between rounded-3xl border-2 border-wakil-amber bg-card/95 p-5 text-start shadow-lg transition-all hover:shadow-xl"
              >
                <div className="flex w-full items-center justify-between">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-wakil-amber/15 text-wakil-amber">
                    <Camera className="size-6" />
                  </span>
                  <span className="rounded-md bg-wakil-amber/15 px-2.5 py-1 text-[10px] font-extrabold text-wakil-amber">
                    جلسة Gemini الحية (صوت + كاميرا + شات)
                  </span>
                </div>
                <div className="mt-4">
                  <h3 className="text-base font-extrabold text-foreground">
                    معنديش سيستم (شغال بدفتر / كشكول أو ببدأ)
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    ندخل مع بعض **جلسة تعريفية حية**: تفتح الكاميرا توريني الكشكول أو المخزن أو البضاعة، أو نتكلم صوت وشات وتبعتلي صور، وأنا أبنيلك السيستم والكتالوج والأدوات أوتوماتيك!
                  </p>
                </div>
                <div className="mt-5 flex w-full items-center justify-between border-t border-border/60 pt-3 text-xs font-extrabold text-wakil-amber">
                  <span>ابدأ الجلسة التعريفية الحية</span>
                  <ArrowLeft className="size-4" />
                </div>
              </motion.button>

              {/* Branch B: Has Existing System -> Build Tools & Control Immediately */}
              <motion.button
                type="button"
                whileHover={{ y: -4, scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setHasExistingSystem(true)
                  setAvatarState('analyzing_tools')
                  sfx.playModelSwitch()
                  setStep(2)
                  void runMultimodalAnalysis({
                    messageText: `عندي سيستم جاهز لمشروع ${businessName} (${businessType}) وعايز أبني أدوات متابعة ذكية للمخزون والمبيعات والربحية`,
                  })
                }}
                className="flex flex-col items-start justify-between rounded-3xl border border-border bg-card/90 p-5 text-start shadow-sm transition-all hover:border-primary/60 hover:shadow-md"
              >
                <div className="flex w-full items-center justify-between">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <MonitorCheck className="size-6" />
                  </span>
                  <span className="rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-extrabold text-primary">
                    تجهيز الأدوات والبلاجنز الذكية
                  </span>
                </div>
                <div className="mt-4">
                  <h3 className="text-base font-extrabold text-foreground">
                    عندي سيستم على الكمبيوتر وعايز أتحكم وأبني أدوات
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    نربط بياناتك أو ترفع لقطة من شاشة السيستم/التقارير، ووكيل يبنيلك أدوات التحليل والمراقبة التلقائية والذاكرة السياقية في ثواني.
                  </p>
                </div>
                <div className="mt-5 flex w-full items-center justify-between border-t border-border/60 pt-3 text-xs font-extrabold text-primary">
                  <span>تخصيص الأدوات والربط الفوري</span>
                  <ArrowLeft className="size-4" />
                </div>
              </motion.button>
            </div>

            <button
              type="button"
              onClick={() => setStep(0)}
              className="mt-5 text-xs font-semibold text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              رجوع لتعديل الاسم أو النشاط
            </button>
          </motion.div>
        )}

        {/* ===================================================================
            STAGE 2: LIVE MULTIMODAL GEMINI DISCOVERY SESSION
            (Camera Inspector + Voice + Photo Scanner + Motion Composer + Live ERP Preview)
           =================================================================== */}
        {step === 2 && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            {/* Right Column (7 cols): Live Multimodal Studio (Camera + Voice + Chat + Thinking Box) */}
            <motion.div
              ref={studioBoxRef}
              onMouseMove={handleBoxMouseMove}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                backgroundImage: `radial-gradient(380px circle at ${mousePos.pxX}px ${mousePos.pxY}px, rgba(217, 119, 6, 0.42), transparent 75%), radial-gradient(420px circle at ${100 - mousePos.x}% ${100 - mousePos.y}%, rgba(13, 148, 136, 0.28), transparent 80%)`,
              }}
              className="flex flex-col rounded-3xl p-[2px] shadow-xl lg:col-span-7"
            >
              <div className="glass-strong flex flex-1 flex-col justify-between rounded-[calc(1.5rem-2px)] bg-card/95 p-4 sm:p-5">
                {/* Studio Top Bar: Avatar + Camera/Photo/Mic Controls */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar state={avatarState} size="md" />
                    <div>
                      <h3 className="text-sm font-extrabold">
                        الجلسة التعريفية الحية لـ «{businessName || 'مشروعك'}»
                      </h3>
                      <p className="text-[11px] text-muted-foreground">
                        {analyzing
                          ? 'وكيل بيحلل المشهد والكلام بـ Gemini وبيستخرج الأصناف والأدوات…'
                          : 'افتح الكاميرا ووريني الكشكول/المخزن، أو ارفع صورة، أو اتكلم معايا'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {/* Live Camera Toggle */}
                    <Button
                      type="button"
                      size="sm"
                      variant={cameraActive ? 'default' : 'outline'}
                      onClick={() => void toggleCamera()}
                      className={cn(
                        'press h-8 gap-1.5 rounded-xl text-xs font-bold',
                        cameraActive && 'bg-emerald-600 text-white hover:bg-emerald-700',
                      )}
                    >
                      {cameraActive ? <CameraOff className="size-3.5" /> : <Camera className="size-3.5" />}
                      <span>{cameraActive ? 'إغلاق الكاميرا' : 'كاميرا مباشرة'}</span>
                    </Button>

                    {/* Upload Photo of Notebook / Store */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="press h-8 gap-1.5 rounded-xl text-xs font-bold"
                    >
                      <ImagePlus className="size-3.5 text-wakil-amber" />
                      <span>صورة كشكول/مخزن</span>
                    </Button>
                  </div>
                </div>

                {/* Live Camera Feed / Captured Image Inspector */}
                {(cameraActive || capturedPreview) && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="relative mt-3 overflow-hidden rounded-2xl border border-wakil-amber/40 bg-black/90"
                  >
                    {cameraActive ? (
                      <div className="relative aspect-video w-full">
                        <video
                          ref={videoRef}
                          autoPlay
                          playsInline
                          muted
                          className="h-full w-full object-cover"
                        />
                        {/* Scanning laser overlay */}
                        <div className="pointer-events-none absolute inset-x-4 top-1/2 h-0.5 bg-gradient-to-r from-transparent via-amber-400 to-transparent opacity-80 shadow-[0_0_12px_#f59e0b]" />
                        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2 px-3">
                          <Button
                            type="button"
                            size="sm"
                            onClick={captureCameraFrame}
                            disabled={analyzing}
                            className="h-9 gap-1.5 rounded-xl bg-wakil-amber font-extrabold text-white shadow-lg hover:bg-wakil-amber/90"
                          >
                            <Wand2 className="size-4" />
                            <span>التقط وحلّل الكشكول / المخزن بـ Gemini</span>
                          </Button>
                        </div>
                      </div>
                    ) : capturedPreview ? (
                      <div className="relative flex items-center justify-between gap-3 p-2.5">
                        <img
                          src={capturedPreview}
                          alt="لقطة الكشكول أو المخزن"
                          className="h-20 w-28 rounded-xl object-cover ring-1 ring-white/20"
                        />
                        <div className="flex-1 text-xs text-white/90">
                          <p className="font-bold text-amber-400">تم التقاط وتحليل الصورة بـ Gemini Vision ✅</p>
                          <p className="mt-0.5 text-[11px] text-white/70">
                            الأصناف والحسابات المستخرجة ظهرت في لوحة النظام على الشمال — تقدر تصور صفحة كمان أو تعدلها.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCapturedPreview(null)}
                          className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    ) : null}
                  </motion.div>
                )}

                {/* Live Conversation Stream */}
                <div className="scroll-warm my-3 flex max-h-60 min-h-44 flex-1 flex-col gap-2.5 overflow-y-auto px-1">
                  {chatHistory.map((m, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, y: 10, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 26 }}
                      className={cn(
                        'max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed shadow-2xs',
                        m.role === 'user'
                          ? 'ms-auto bg-[var(--wakil-amber-soft)] font-semibold text-accent-foreground'
                          : 'me-auto border border-border/70 bg-background/90 text-foreground',
                      )}
                    >
                      {m.text}
                    </motion.div>
                  ))}

                  {analyzing && (
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="me-auto flex items-center gap-2 rounded-2xl border border-wakil-amber/40 bg-wakil-amber/10 px-3.5 py-2 text-xs font-bold text-wakil-amber"
                    >
                      <Loader2 className="size-3.5 animate-spin" />
                      <span>عقل وكيل بيحلل وبيبني الكتالوج والأدوات…</span>
                    </motion.div>
                  )}
                </div>

                {/* Quick Example Prompts for Discovery */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {[
                    'عندي بن محوج بـ 420 وحبهان بـ 950 والحاج سعيد عليه 600 جنيه',
                    'ببيع لبن جهينة بـ 45 وأرز بـ 35 وعايز أراقب النواقص والربحية',
                    'إحنا صيدلية وعندنا أوجمنتين بـ 135 وبانادول بـ 54 وعايز رادار صلاحيات',
                  ].map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => void runMultimodalAnalysis({ messageText: sample })}
                      className="press rounded-xl border border-border/70 bg-background/70 px-2.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-wakil-amber/50 hover:text-foreground"
                    >
                      + «{sample.slice(0, 48)}…»
                    </button>
                  ))}
                </div>

                {/* Motion-Graphics Onboarding Input Box with Bow & Arrow Send */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (!liveInput.trim()) return
                    setBowState('drawing')
                    sfx.playBowDraw()
                    setTimeout(() => {
                      setBowState('launching')
                      sfx.playArrowLaunch()
                      void runMultimodalAnalysis({ messageText: liveInput })
                      setTimeout(() => setBowState('idle'), 320)
                    }, 100)
                  }}
                  className="flex items-center gap-2 rounded-2xl border border-wakil-amber/40 bg-background/95 p-1.5 shadow-inner focus-within:ring-2 focus-within:ring-wakil-amber/30"
                >
                  <button
                    type="button"
                    onClick={toggleVoice}
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors',
                      listening
                        ? 'bg-teal-500/20 text-teal-600 ring-1 ring-teal-500/40'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                    title="تحدث بالصوت مع وكيل"
                  >
                    {listening ? <MicOff className="size-4 animate-pulse" /> : <Mic className="size-4" />}
                  </button>

                  <input
                    type="text"
                    value={liveInput}
                    onChange={(e) => {
                      setLiveInput(e.target.value)
                      setAvatarState(e.target.value.trim() ? 'thinking' : 'idle')
                    }}
                    placeholder={
                      listening
                        ? '🎙️ اتكلم دلوقتي… احكيلي عن بضاعتك أو الكشكول'
                        : 'احكيلي عن أصنافك وأسعارك أو الديون اللي في الكشكول…'
                    }
                    className="h-9 flex-1 bg-transparent px-2 text-xs font-medium focus:outline-none sm:text-sm"
                  />

                  <motion.button
                    type="submit"
                    disabled={!liveInput.trim() || analyzing}
                    whileHover={{ scale: 1.05 }}
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors',
                      liveInput.trim()
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'bg-muted text-muted-foreground/40',
                    )}
                  >
                    <svg viewBox="0 0 24 24" className="size-4.5">
                      <motion.path
                        d={
                          bowState === 'drawing'
                            ? 'M 4 14 Q 12 21 20 14'
                            : bowState === 'launching'
                              ? 'M 4 14 Q 12 8 20 14'
                              : 'M 5 15 Q 12 15 19 15'
                        }
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeOpacity="0.6"
                      />
                      <motion.path
                        animate={
                          bowState === 'drawing'
                            ? { y: 4 }
                            : bowState === 'launching'
                              ? { y: [-2, -16, 0] }
                              : { y: 0 }
                        }
                        d="M 12 18 L 12 6 M 8 10 L 12 6 L 16 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </motion.button>
                </form>
              </div>
            </motion.div>

            {/* Left Column (5 cols): Real-Time Extracted System, Catalog, Parties & Plugins Blueprint */}
            <motion.div
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex flex-col justify-between rounded-3xl border border-border/80 bg-card/90 p-5 shadow-lg lg:col-span-5"
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-border/60 pb-3">
                  <div className="flex items-center gap-2">
                    <NotebookPen className="size-4.5 text-wakil-amber" />
                    <h3 className="text-sm font-extrabold">السيستم والأدوات اللي وكيل جهزهالك</h3>
                  </div>
                  <span className="num rounded-md bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                    جاهز للتشغيل
                  </span>
                </div>

                {/* Opening Cash Input */}
                <div className="flex items-center justify-between rounded-xl border border-border/70 bg-background/70 px-3 py-2">
                  <span className="text-xs font-bold text-muted-foreground">رصيد الخزنة الافتتاحي (ج.م):</span>
                  <input
                    type="number"
                    value={openingCashEgp}
                    onChange={(e) => setOpeningCashEgp(Number(e.target.value || 0))}
                    className="num w-28 rounded-lg border border-border bg-card px-2 py-1 text-end text-xs font-extrabold"
                  />
                </div>

                {/* Extracted Items */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-extrabold">
                      <Boxes className="size-3.5 text-wakil-amber" />
                      <span>الأصناف المستخرجة ({extractedItems.length})</span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setExtractedItems((prev) => [
                          { name: 'صنف جديد', unit: 'قطعة', sellPriceEgp: 50, costPriceEgp: 38, stockQty: 20, category: 'عام' },
                          ...prev,
                        ])
                      }
                      className="flex items-center gap-1 text-[10px] font-bold text-primary hover:underline"
                    >
                      <Plus className="size-3" />
                      <span>إضافة صنف</span>
                    </button>
                  </div>
                  <div className="scroll-warm max-h-36 space-y-1.5 overflow-y-auto pe-1">
                    {extractedItems.map((it, idx) => (
                      <motion.div
                        key={`${it.name}-${idx}`}
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.04 }}
                        className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/80 px-2.5 py-1.5 text-xs"
                      >
                        <span className="truncate font-bold">{it.name}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="num text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                            {it.sellPriceEgp} ج.م
                          </span>
                          <span className="num text-[10px] text-muted-foreground">
                            ({it.stockQty} {it.unit})
                          </span>
                          <button
                            type="button"
                            onClick={() => setExtractedItems((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-muted-foreground/60 hover:text-destructive"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>

                {/* Extracted Customers / Suppliers */}
                {extractedParties.length > 0 && (
                  <div>
                    <span className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold">
                      <Users className="size-3.5 text-wakil-amber" />
                      <span>حسابات العملاء والموردين ({extractedParties.length})</span>
                    </span>
                    <div className="space-y-1">
                      {extractedParties.map((p, idx) => (
                        <div
                          key={`${p.name}-${idx}`}
                          className="flex items-center justify-between rounded-xl border border-border/60 bg-background/80 px-2.5 py-1.5 text-xs"
                        >
                          <span className="truncate font-semibold">{p.name}</span>
                          <span className="num text-[11px] font-bold text-wakil-amber">
                            {p.balanceEgp} ج.م
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Auto-Synthesized Plugins */}
                <div>
                  <span className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold">
                    <Cpu className="size-3.5 text-primary" />
                    <span>الأدوات الذكية اللي هتتفعل في نظامك ({suggestedPlugins.length})</span>
                  </span>
                  <div className="space-y-1.5">
                    {suggestedPlugins.map((pl, idx) => (
                      <motion.div
                        key={pl.slug || idx}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className="rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs"
                      >
                        <span className="block font-extrabold text-primary">{pl.name}</span>
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">{pl.description}</span>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Final 1-Click Provision Button */}
              <div className="mt-5 border-t border-border/60 pt-4">
                <Button
                  type="button"
                  disabled={provisioning}
                  onClick={() => void handleProvisionAndStart()}
                  className="h-12 w-full rounded-2xl text-sm font-extrabold shadow-lg shadow-primary/25 transition-transform hover:scale-[1.01] active:scale-98"
                >
                  {provisioning ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" />
                      <span>جاري بناء قاعدة البيانات وتفعيل الأدوات…</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Sparkles className="size-4" />
                      <span>اعتمد وابني السيستم والأدوات وابدأ الشغل فوراً</span>
                    </span>
                  )}
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </div>
  )
}
