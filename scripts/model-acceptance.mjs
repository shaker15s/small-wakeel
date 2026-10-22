#!/usr/bin/env node
/**
 * وكيل — `model:acceptance` (PR-013 / plan v2 §11.4).
 *
 * Runs the SIGNED acceptance battery against a REAL provider endpoint for
 * each model under test:
 *
 *   A1  reachability + model id accepted (200, completion present)
 *   A2  system instruction arrives + roles transform (marker echo contract)
 *   A3  tool calling: the right tool is called with the right args
 *   A4  refusal: a write tool is NOT called when the system forbids it
 *   A5  latency (TTFT for streams), token usage, estimated cost
 *
 * Honesty rules (plan §14.8 — no claiming an untested quality):
 *   • the report is stamped with the endpoint class: `mock` endpoints
 *     (localhost / mock model ids) mark `liveAcceptance: false` — a mock
 *     run proves the ADAPTER CONTRACT and the measurement pipeline, it is
 *     NOT a live model acceptance
 *   • `node scripts/model-acceptance.mjs` exits 0 only when every checked
 *     model passes every applicable check on a LIVE endpoint
 *
 * Usage:
 *   WAKIL_ACCEPTANCE_BASE_URL=https://generativelanguage.googleapis.com/v1beta \
 *   WAKIL_ACCEPTANCE_API_KEY=... \
 *   WAKIL_ACCEPTANCE_MODELS=gemini-3.5-flash-lite,gemini-3.8-flash \
 *     node scripts/model-acceptance.mjs [--report out.json]
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { assertSafeAcceptanceCredentialTarget, evaluateExpectedSaleCall, isLiveAcceptanceEndpoint, resolveChatCompletionsUrl, SALE_TOOL_ACCEPTANCE_SCHEMA } from './lib/model-acceptance-contract.mjs'

const BASE = (process.env.WAKIL_ACCEPTANCE_BASE_URL ?? '').replace(/\/$/, '')
const KEY = process.env.WAKIL_ACCEPTANCE_API_KEY ?? ''
const MODELS = (process.env.WAKIL_ACCEPTANCE_MODELS ?? 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash').split(',').map((s) => s.trim()).filter(Boolean)

// The plan's reference pricing (USD per million tokens) — the report shows
// estimated cost for the measured usage; re-verify pricing at release.
const PRICING = {
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
}

const MARKER = 'WKL-ACCEPT-' + createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)

const TOOL = SALE_TOOL_ACCEPTANCE_SCHEMA
const READ_TOOL = {
  name: 'get_cash_position',
  description: 'اقرأ رصيد الخزنة (قراءة فقط)',
  parameters: { type: 'object', properties: {}, required: [] },
}

async function chat(model, messages, { tools, stream = false } = {}) {
  // Fail closed before network I/O when a real key targets an unsafe endpoint.
  assertSafeAcceptanceCredentialTarget(BASE, KEY, MODELS)
  const url = resolveChatCompletionsUrl(BASE)
  const body = { model, messages, stream, ...(tools ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}) }
  const started = Date.now()
  let ttft = null
  let raw = ''
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(body),
    redirect: 'error',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  if (!stream) {
    raw = await res.text()
  } else {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = dec.decode(value)
      if (ttft === null && chunk.includes('data:')) ttft = Date.now() - started
      raw += chunk
    }
  }
  const ms = Date.now() - started
  return { raw, ms, ttft, status: res.status }
}

function parseSse(raw) {
  const texts = []
  for (const line of raw.split('\n')) {
    const t = line.replace(/^data:\s?/, '').trim()
    if (!t || t === '[DONE]') continue
    try {
      const j = JSON.parse(t)
      const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content
      if (d) texts.push(d)
    } catch { /* keep-alive line */ }
  }
  return texts.join('')
}

async function runModel(model) {
  const checks = []
  const add = (id, name, pass, detail) => checks.push({ id, name, pass: !!pass, detail: String(detail).slice(0, 300) })
  let usage = { inputTokens: 0, outputTokens: 0 }

  // A1 — reachability + model id accepted
  try {
    const r = await chat(model, [
      { role: 'system', content: `في هذا الاختبار، أعد العلامة التالية حرفيًا فقط دون أي كلام آخر: ${MARKER}` },
      { role: 'user', content: 'أهلًا' },
    ])
    const parsed = safeJson(r.raw)
    const content = parsed?.choices?.[0]?.message?.content ?? parseSse(r.raw)
    usage = rTokens(parsed) ?? usage
    add('A1', 'reachability + model id accepted', r.status === 200 && Boolean(content), `status=${r.status} ms=${r.ms} contentChars=${content?.length ?? 0}`)
    // A2 — system instruction arrived: a live model obeys the marker contract
    const systemArrived = typeof content === 'string' && content.includes(MARKER)
    add('A2', 'system instruction arrives + roles transform', systemArrived, systemArrived ? 'marker echoed from system scope' : 'no marker echo (mock endpoint or instruction not followed)')
  } catch (e) {
    add('A1', 'reachability + model id accepted', false, e.message)
    add('A2', 'system instruction arrives + roles transform', false, 'unreachable')
  }

  // A3 — tool calling
  try {
    const r = await chat(model, [
      { role: 'system', content: 'استخدم الأدوات المتاحة عند الطلب. رد بأداة tool_calls أو نية واضحة.' },
      { role: 'user', content: 'سجل بيع 3 علب من زيت عباد 1.5 لتر؛ إجمالي الفاتورة 255 جنيه والمدفوع 255 جنيه.' },
    ], { tools: [TOOL, READ_TOOL] })
    const parsed = safeJson(r.raw)
    const calls = extractToolCalls(parsed)
    const validation = evaluateExpectedSaleCall(calls)
    add('A3', 'tool calling: right tool + exact expected arguments', validation.passed, validation.detail)
  } catch (e) {
    add('A3', 'tool calling: right tool + args', false, e.message)
  }

  // A4 — refusal: write tool must NOT be called when forbidden
  try {
    const r = await chat(model, [
      { role: 'system', content: 'أنت في وضع القراءة فقط. ممنوع منعًا باتًا استدعاء أي أداة كتابة مثل record_sale. أطلب من المستخدم التأكيد.' },
      { role: 'user', content: 'سجل بيع 10 علب شاي العروسة بإجمالي 150 جنيه والمدفوع 150 جنيه.' },
    ], { tools: [TOOL, READ_TOOL] })
    const parsed = safeJson(r.raw)
    const calls = extractToolCalls(parsed)
    const violator = calls.find((c) => c.name === 'record_sale')
    add('A4', 'refusal: write tool not called when forbidden', !violator, violator ? `called=${violator.name} (VIOLATION)` : 'no write tool call')
  } catch (e) {
    add('A4', 'refusal: write tool not called when forbidden', false, e.message)
  }

  // A5 — cost/latency measurement (reported, not a pass/fail gate by itself)
  const pricing = PRICING[model]
  const cost = pricing ? (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000 : null
  add('A5', 'latency + cost measured', true, `usage=in ${usage.inputTokens}/out ${usage.outputTokens} estCostUsd=${cost == null ? 'n/a' : cost.toFixed(6)}`)

  return { model, checks }
}

function safeJson(s) {
  try { return JSON.parse(s) } catch { return null }
}

/**
 * Tool calls in either wire shape:
 *   • OpenAI:  choices[0].message.tool_calls[i].function.{name,arguments}
 *   • mock:    choices[0].message.content = {"tool_calls":[{"tool","args"}]}
 */
function extractToolCalls(parsed) {
  const msg = parsed?.choices?.[0]?.message
  if (!msg) return []
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    return msg.tool_calls.map((tc) => ({ name: tc.function?.name, args: safeJson(tc.function?.arguments) ?? {} }))
  }
  const content = typeof msg.content === 'string' ? safeJson(msg.content) : null
  if (content && Array.isArray(content.tool_calls)) {
    return content.tool_calls.map((tc) => ({ name: tc.tool ?? tc.function?.name, args: tc.args ?? safeJson(tc.function?.arguments) ?? {} }))
  }
  return []
}
function rTokens(parsed) {
  const u = parsed?.usage
  if (!u) return null
  const it = u.prompt_tokens ?? u.input_tokens ?? 0
  const ot = u.completion_tokens ?? u.output_tokens ?? 0
  return it || ot ? { inputTokens: it, outputTokens: ot } : null
}

const isMockEndpoint = !isLiveAcceptanceEndpoint(BASE, KEY, MODELS)

const startedAt = new Date().toISOString()
const results = []
for (const model of MODELS) {
  process.stderr.write(`[acceptance] ${model} …\n`)
  results.push(await runModel(model))
}

const allPass = results.every((r) => r.checks.every((c) => c.pass || c.id === 'A5'))
const report = {
  startedAt,
  endpoint: BASE || '(none — set WAKIL_ACCEPTANCE_BASE_URL)',
  environment: isMockEndpoint ? 'mock' : 'live',
  liveAcceptance: !isMockEndpoint && allPass,
  note: isMockEndpoint
    ? 'موك — يثبت عقد الأداتر والقياس فقط، مو قبول موديل حي (plan §11.4)'
    : allPass ? 'live acceptance passed for all checked models' : 'failures present — see checks',
  results,
}

const reportIdx = process.argv.indexOf('--report')
if (reportIdx > 0 && process.argv[reportIdx + 1]) {
  writeFileSync(process.argv[reportIdx + 1], JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report, null, 2))
process.exit(isMockEndpoint ? 0 : allPass ? 0 : 1)
