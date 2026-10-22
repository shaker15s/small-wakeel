import ipaddr from 'ipaddr.js'

const GOOGLE_OPENAI_HOST = 'generativelanguage.googleapis.com'

/** A mock is an explicitly local endpoint; model names alone never make a remote URL safe. */
export function isLoopbackAcceptanceEndpoint(base) {
  try {
    const url = new URL(base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (host === 'localhost' || host.endsWith('.localhost')) return true
    return ipaddr.process(host).range() === 'loopback'
  } catch {
    return false
  }
}

/** Only a local loopback endpoint is allowed to stand in for a model provider. */
export function isMockAcceptanceEndpoint(base, _models = []) {
  return isLoopbackAcceptanceEndpoint(base)
}

/**
 * Mirror the application's authoritative record_sale contract. The unit
 * suite compares this fixture to brainToolSchemas() so the live acceptance
 * test cannot silently drift into testing a made-up tool shape.
 */
export const SALE_TOOL_ACCEPTANCE_SCHEMA = {
  name: 'record_sale',
  description: 'مسودة بيع صنف (كمية وسعر). «بعت …».',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      qty: { type: 'number' },
      price: { type: 'number' },
      paid: { type: 'number' },
      total: { type: 'number' },
      customer: { type: 'string' },
    },
    required: ['name', 'qty'],
    additionalProperties: true,
  },
}

/** Resolve an OpenAI-compatible chat-completions URL from a provider base URL. */
export function resolveChatCompletionsUrl(base) {
  if (typeof base !== 'string' || !base.trim()) {
    throw new Error('WAKIL_ACCEPTANCE_BASE_URL must be an explicit API base URL')
  }

  const url = new URL(base.trim())
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API base URL must not contain credentials, query strings, or fragments')
  }

  const path = url.pathname.replace(/\/+$/, '')

  if (url.hostname.toLowerCase() === GOOGLE_OPENAI_HOST && path === '/v1beta') {
    url.pathname = '/v1beta/openai/chat/completions'
  } else if (path.endsWith('/chat/completions')) {
    url.pathname = path
  } else {
    url.pathname = `${path}/chat/completions`.replace(/^\/\/chat\/completions$/, '/chat/completions')
  }

  return url.toString()
}

function isPrivateOrLocalHost(rawHostname) {
  const host = String(rawHostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')

  const nonPublicSuffixes = [
    'localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'home.arpa',
    'test', 'invalid',
  ]
  if (nonPublicSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true

  // Use the same IP-range classifier as the server-side provider transport.
  // Do not enumerate only common RFC1918 ranges: link-local IPv6 (fe80::/10),
  // multicast, documentation, reserved, and IPv4-mapped IPv6 must fail too.
  try {
    return ipaddr.process(host).range() !== 'unicast'
  } catch {
    // Hostnames are not IP literals. Reject single-label names; a provider must
    // be configured with a real public DNS name rather than an internal alias.
    return !host.includes('.')
  }
}

/**
 * A live acceptance result requires a credential, HTTPS, a public host and
 * non-mock model IDs. This is classification, not a substitute for provider
 * authentication or the application's own network egress controls.
 */
export function isLiveAcceptanceEndpoint(base, apiKey, models = []) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) return false
  if (!Array.isArray(models) || models.length === 0 || models.some((model) => /mock/i.test(String(model)))) return false

  try {
    const url = new URL(base)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false
    if (!url.hostname || isPrivateOrLocalHost(url.hostname)) return false
    return true
  } catch {
    return false
  }
}

/**
 * Fail before any network I/O unless this is either (a) an uncredentialed local
 * adapter mock, or (b) a credentialed HTTPS endpoint classified as live. A
 * model id containing "mock" is not permission to send prompts to a remote URL.
 */
export function assertSafeAcceptanceCredentialTarget(base, apiKey, models = []) {
  if (typeof base !== 'string' || !base.trim()) {
    throw new Error('WAKIL_ACCEPTANCE_BASE_URL is required; no request was sent')
  }
  if (isLoopbackAcceptanceEndpoint(base)) {
    if (apiKey) throw new Error('Refusing to send WAKIL_ACCEPTANCE_API_KEY to a local mock endpoint')
    return
  }
  if (!isLiveAcceptanceEndpoint(base, apiKey, models)) {
    throw new Error('Refusing uncredentialed or unsafe model acceptance target; use an uncredentialed loopback mock or a keyed HTTPS public endpoint')
  }
}

function normalizeDigits(value) {
  return String(value)
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٫،]/g, '.')
    .trim()
}

/** Check a real WAKIL record_sale call, not just the name or a made-up schema. */
export function evaluateExpectedSaleCall(calls) {
  const call = Array.isArray(calls) ? calls.find((item) => item?.name === 'record_sale') : null
  if (!call) return { passed: false, detail: 'The model did not call record_sale.' }

  const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {}
  const name = normalizeDigits(args.name ?? '').toLowerCase()
  const readNumber = (value) => {
    const normalized = normalizeDigits(value ?? '')
    return normalized ? Number(normalized) : Number.NaN
  }
  const qty = readNumber(args.qty)
  const price = readNumber(args.price)
  const total = readNumber(args.total)
  const paid = readNumber(args.paid)
  const nameMatches = name.includes('زيت') && name.includes('عباد') && name.includes('1.5')
  const qtyMatches = Number.isFinite(qty) && qty === 3
  const priceMatches = Number.isFinite(price) && price === 85
  const totalMatches = Number.isFinite(total) && total === qty * price
  const paidMatches = Number.isFinite(paid) && paid === total
  const passed = nameMatches && qtyMatches && priceMatches && totalMatches && paidMatches

  return {
    passed,
    detail: `name=${name || '(missing)'}; qty=${Number.isFinite(qty) ? qty : '(invalid/missing)'}; price=${Number.isFinite(price) ? price : '(invalid/missing)'}; total=${Number.isFinite(total) ? total : '(invalid/missing)'}; paid=${Number.isFinite(paid) ? paid : '(invalid/missing)'}; expected زيت عباد 1.5 / qty 3 × unit price 85 = total 255 / paid 255`,
  }
}
