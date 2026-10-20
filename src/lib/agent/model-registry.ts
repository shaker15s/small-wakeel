// وكيل — MODEL REGISTRY (PR-013 / plan v2 §11.1).
//
// Model ids and capabilities are DATA, reviewed against official sources —
// never names hard-wired into prompts or scattered across code. The plan's
// rule: pick the CHEAPEST model that PASSES the task's eval set — a model is
// not promoted for price alone, and deterministic money math is NEVER a
// model job.
//
// Honest statuses in this build:
//   • the deployed set (what the live runtime calls today) is
//     `deployed` — verified end-to-end in this environment via the mock
//     provider; a live-provider acceptance run is a separate gate
//   • the plan's candidates (3.5-flash-lite / 3.1-flash-lite / 3.8-flash /
//     3.8-live) are `candidate` — reviewed + priced, awaiting their eval
//   • nothing is ever `deprecated` silently — it is excluded from routing
//     and said so

export type ModelTier = 'air' | 'balanced' | 'deep' | 'live'
export type ModelStatus = 'deployed' | 'candidate' | 'deprecated'

export interface RegistryModel {
  id: string
  provider: 'gemini' | 'openai-compatible'
  tier: ModelTier
  capabilities: {
    toolCalling: boolean
    structuredOutput: boolean
    streaming: boolean
    multimodal: boolean
  }
  /** USD per million tokens (reference from the plan's reviewed sources). */
  pricingUsdPerMillion: { input: number; output: number }
  /** Live-audio models bill per minute of audio, not per token. */
  perMinuteUsd?: { in: number; out: number }
  status: ModelStatus
  evaluated: { passed: boolean; suite?: string; at?: string; evidence?: string }
  reviewedAt: string
  reviewedSource: string
  note?: string
}

/**
 * The plan's reviewed candidates (sources reviewed 2026-10-20:
 * https://ai.google.dev/gemini-api/docs/models + /pricing). Prices are a
 * comparison reference, not a quote — re-verify at each release.
 */
export const REGISTRY: RegistryModel[] = [
  // ── deployed (what the runtime calls today) ─────────────────────────────
  {
    id: 'gemini-3-flash-preview',
    provider: 'gemini',
    tier: 'balanced',
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 0.75, output: 3.0 },
    status: 'deployed',
    evaluated: { passed: true, suite: 'harness-battery (R69)', at: '2026-10-20', evidence: 'mock-verified end-to-end; live acceptance pending' },
    reviewedAt: '2026-10-20',
    reviewedSource: 'plan v2 §11 (ai.google.dev pricing/models)',
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    tier: 'deep',
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 1.5, output: 6.0 },
    status: 'deployed',
    evaluated: { passed: true, suite: 'harness-battery (R69)', at: '2026-10-20', evidence: 'mock-verified end-to-end; live acceptance pending' },
    reviewedAt: '2026-10-20',
    reviewedSource: 'plan v2 §11 (ai.google.dev pricing/models)',
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    provider: 'gemini',
    tier: 'air',
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 0.25, output: 1.5 },
    status: 'deployed',
    evaluated: { passed: true, suite: 'harness-battery (R69)', at: '2026-10-20', evidence: 'mock-verified end-to-end; live acceptance pending' },
    reviewedAt: '2026-10-20',
    reviewedSource: 'plan v2 §11 (ai.google.dev pricing/models)',
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    tier: 'balanced',
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 0.3, output: 2.5 },
    status: 'deployed',
    evaluated: { passed: true, suite: 'legacy fallback', at: '2026-10-18', evidence: 'last-resort rung of the fallback ladders' },
    reviewedAt: '2026-10-18',
    reviewedSource: 'deployed fallback set',
    note: 'legacy fallback rung — kept so a provider outage has a landing spot',
  },
  // ── plan candidates (awaiting their eval) ───────────────────────────────
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    tier: 'air',
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 0.3, output: 2.5 },
    status: 'candidate',
    evaluated: { passed: false, evidence: 'awaiting Egyptian-dialect + tool-calling eval (plan: do not pick on price alone)' },
    reviewedAt: '2026-10-20',
    reviewedSource: 'plan v2 §11.1 — Google recommends for new projects; $0.30/$2.50 per M',
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    tier: 'air',
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 0.25, output: 1.5 },
    status: 'candidate',
    evaluated: { passed: false, evidence: 'price-comparison candidate only (plan §11.1); not chosen on price alone' },
    reviewedAt: '2026-10-20',
    reviewedSource: 'plan v2 §11.1 — $0.25/$1.50 per M if still officially available',
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'gemini',
    tier: 'deep',
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 0.75, output: 3.75 },
    status: 'candidate',
    evaluated: { passed: false, evidence: 'candidate for context-heavier tasks; eval pending' },
    reviewedAt: '2026-10-20',
    reviewedSource: 'plan v2 §11.1 — $0.75/$3.75 per M until 31 Dec 2026, higher after',
  },
  {
    id: 'gemini-3.8-live',
    provider: 'gemini',
    tier: 'live',
    capabilities: { toolCalling: false, structuredOutput: false, streaming: true, multimodal: true },
    pricingUsdPerMillion: { input: 0, output: 0 },
    perMinuteUsd: { in: 0.005, out: 0.018 },
    status: 'candidate',
    evaluated: { passed: false, evidence: 'optional, NOT required for launch (plan §11.1); live-audio eval + real-voice cost pending' },
    reviewedAt: '2026-10-20',
    reviewedSource: 'plan v2 §11.1 — ≈$0.005/min in, $0.018/min out; confirm at run time',
    note: 'a Live model is not a replacement for the text planning model; the backend keeps authorization/execution/verification',
  },
]

const byId = new Map(REGISTRY.map((m) => [m.id, m]))
export function getRegistryModel(id: string): RegistryModel | undefined {
  return byId.get(id)
}

// ---------------------------------------------------------------------------
// Routing policy (plan §11.2)
// ---------------------------------------------------------------------------

export type RoutingIntent = 'fast_text' | 'context' | 'deep' | 'deterministic'

/**
 * Fallback ladders per UI tier — the EXACT current order of
 * llm.ts geminiModelCandidates, now declared as data. A `candidate` model
 * may prepend its ladder ONLY after it passes the eval (promoteModel), so
 * today the ladders behave exactly as before.
 */
export const FALLBACK_LADDERS: Record<'air' | 'balanced' | 'deep', string[]> = {
  air: ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
  balanced: ['gemini-3-flash-preview', 'gemini-2.5-flash'],
  deep: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
}

export interface RoutingDecision {
  modelId: string | null
  ladder: string[]
  reason: string
}

const INTENT_TIER: Record<Exclude<RoutingIntent, 'deterministic'>, 'air' | 'balanced' | 'deep'> = {
  fast_text: 'air',
  context: 'balanced',
  deep: 'deep',
}

/**
 * Cheapest-passing-first selection:
//   1. eval-passed candidates of the right tier, cheapest first
//   2. the deployed fallback ladder (unchanged behaviour)
// `deterministic` is NEVER routed to a model — money math, unit conversion,
// discount selection and balance computation are deterministic code, no
// matter how strong the model is (plan §11.2).
 */
export function selectForIntent(intent: RoutingIntent): RoutingDecision {
  if (intent === 'deterministic') {
    return {
      modelId: null,
      ladder: [],
      reason: 'حسابات المال وتحويل الوحدات واختيار الخصم والأرصدة: كود حتمي واختبارات — لا يُكلَّف الموديل',
    }
  }
  const tier = INTENT_TIER[intent]
  const passingCandidates = REGISTRY.filter(
    (m) => m.tier === tier && m.status === 'candidate' && m.evaluated.passed && m.id !== 'gemini-2.5-flash',
  ).sort((a, b) => a.pricingUsdPerMillion.input - b.pricingUsdPerMillion.input)

  const ladder = [
    ...passingCandidates.map((m) => m.id),
    ...FALLBACK_LADDERS[tier].filter((id) => {
      const m = byId.get(id)
      return m && m.status !== 'deprecated'
    }),
  ]
  if (ladder.length === 0) {
    return { modelId: null, ladder: [], reason: 'لا يوجد موديل متاح لهذا المستوى — راجع الـ registry' }
  }
  return {
    modelId: ladder[0],
    ladder,
    reason: passingCandidates.length > 0
      ? `أرخص مرشح ناجح بالـeval للمستوى ${tier}`
      : `سُلّم المستوى ${tier} — مرشحات الخطة لسه موثقة بالـeval فبنبدأ بالـdeployed`,
  }
}

/**
 * Runtime fallback ladder for a UI model key — data-driven replacement of
 * the hard-coded geminiModelCandidates. Identical output for the current
 * registry state (asserted by tests).
 */
export function candidatesForModelKey(modelKey?: string | null): string[] {
  let tier: 'air' | 'balanced' | 'deep'
  if (modelKey === 'gemini-pro' || modelKey === 'builtin-deep') tier = 'deep'
  else if (modelKey === 'builtin-air') tier = 'air'
  else tier = 'balanced'
  const passing = REGISTRY.filter(
    (m) => m.tier === tier && m.status === 'candidate' && m.evaluated.passed,
  ).sort((a, b) => a.pricingUsdPerMillion.input - b.pricingUsdPerMillion.input)
  return [
    ...passing.map((m) => m.id),
    ...FALLBACK_LADDERS[tier].filter((id) => byId.get(id)?.status !== 'deprecated'),
  ]
}

/**
 * Promote a candidate after its eval passes (called with the eval evidence).
 * In-memory for the process lifetime; the promotion is persisted by the
 * release process (the registry file is the durable source).
 */
export function promoteModel(id: string, evidence: { suite: string; at: string; sha?: string }): RegistryModel {
  const m = byId.get(id)
  if (!m) throw new Error(`موديل غير موجود في الـ registry: ${id}`)
  if (m.status !== 'candidate') throw new Error(`فقط المرشحين يترفعو — «${id}» حالته ${m.status}`)
  // promotion = the eval passed. The model stays a `candidate` in the data
  // file (durable); the release process moves it into the deployed ladder.
  m.evaluated = { passed: true, suite: evidence.suite, at: evidence.at, evidence: evidence.sha ? `sha ${evidence.sha.slice(0, 12)}` : undefined }
  return m
}

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

/** Estimated USD cost for a completion (token models) or a live session. */
export function estimateCostUsd(id: string, usage: { inputTokens: number; outputTokens: number; audioMinutesIn?: number; audioMinutesOut?: number }): number {
  const m = byId.get(id)
  if (!m) throw new Error(`موديل غير موجود: ${id}`)
  const tokens = (usage.inputTokens * m.pricingUsdPerMillion.input + usage.outputTokens * m.pricingUsdPerMillion.output) / 1_000_000
  const audio = m.perMinuteUsd ? (usage.audioMinutesIn ?? 0) * m.perMinuteUsd.in + (usage.audioMinutesOut ?? 0) * m.perMinuteUsd.out : 0
  return tokens + audio
}

/** The registry as a plain DTO (API / docs / the acceptance report). */
export function registryDTO(): Array<Record<string, unknown>> {
  return REGISTRY.map((m) => ({ ...m, capabilities: { ...m.capabilities }, pricingUsdPerMillion: { ...m.pricingUsdPerMillion }, evaluated: { ...m.evaluated } }))
}
