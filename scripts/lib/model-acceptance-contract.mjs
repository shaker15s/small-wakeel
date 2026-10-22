const GOOGLE_OPENAI_HOST = 'generativelanguage.googleapis.com'

/** Resolve an OpenAI-compatible chat-completions URL from a provider base URL. */
export function resolveChatCompletionsUrl(base) {
  if (typeof base !== 'string' || !base.trim()) {
    throw new Error('WAKIL_ACCEPTANCE_BASE_URL must be an explicit API base URL')
  }

  const url = new URL(base.trim())
  if (url.username || url.password) {
    throw new Error('API base URL must not contain embedded credentials')
  }

  url.hash = ''
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
  const host = String(rawHostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::' ||
    host === '::1' ||
    (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')))
  ) return true

  // URLs may normalize an IPv4-mapped IPv6 loopback literal into hex words.
  // Unwrap both dotted and hexadecimal forms before deciding it is public.
  const mappedDotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mappedDotted) return isPrivateOrLocalHost(mappedDotted[1])
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    const ipv4 = [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.')
    return isPrivateOrLocalHost(ipv4)
  }

  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const [a, b] = parts.map(Number)
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
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
    if (url.protocol !== 'https:' || url.username || url.password) return false
    if (!url.hostname || isPrivateOrLocalHost(url.hostname)) return false
    return true
  } catch {
    return false
  }
}

/** Fail before network I/O if an API key would be sent to a non-live endpoint. */
export function assertSafeAcceptanceCredentialTarget(base, apiKey, models = []) {
  if (apiKey && !isLiveAcceptanceEndpoint(base, apiKey, models)) {
    throw new Error('Refusing to send WAKIL_ACCEPTANCE_API_KEY to a non-HTTPS, private, or mock endpoint')
  }
}

function normalizeDigits(value) {
  return String(value)
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٫،]/g, '.')
    .trim()
}

/** Check the actual extracted item, quantity, and amount — not just tool name. */
export function evaluateExpectedSaleCall(calls) {
  const call = Array.isArray(calls) ? calls.find((item) => item?.name === 'record_sale') : null
  if (!call) return { passed: false, detail: 'The model did not call record_sale.' }

  const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {}
  const item = normalizeDigits(args.item ?? '').toLowerCase()
  const qtyText = normalizeDigits(args.qty ?? '')
  const amountText = normalizeDigits(args.amount ?? '')
  const qty = qtyText ? Number(qtyText) : Number.NaN
  const amount = amountText ? Number(amountText) : Number.NaN
  const itemMatches = item.includes('زيت') && item.includes('عباد') && /1\.5/.test(item)
  const qtyMatches = Number.isFinite(qty) && qty === 3
  const amountMatches = Number.isFinite(amount) && amount === 255
  const passed = itemMatches && qtyMatches && amountMatches

  return {
    passed,
    detail: `item=${item || '(missing)'}; qty=${Number.isFinite(qty) ? qty : '(invalid/missing)'}; amount=${Number.isFinite(amount) ? amount : '(invalid/missing)'}; expected زيت عباد 1.5 / 3 / 255`,
  }
}
