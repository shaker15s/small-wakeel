/** Pure helpers for model acceptance tests. No network calls or credentials. */
export function buildChatCompletionsUrl(base) {
  const trimmed = String(base ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('WAKIL_ACCEPTANCE_BASE_URL is required');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Acceptance endpoint must use HTTP(S)');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Acceptance base URL must not contain credentials, query parameters, or fragments');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return parsed.origin + path;
  if (parsed.hostname === 'generativelanguage.googleapis.com') {
    parsed.pathname = path.endsWith('/openai') ? path + '/chat/completions' : path + '/openai/chat/completions';
  } else {
    parsed.pathname = path + '/chat/completions';
  }
  return parsed.origin + parsed.pathname;
}

export function classifyEndpoint(base, models = []) {
  const trimmed = String(base ?? '').trim();
  if (!trimmed) return 'unconfigured';
  let local = false;
  try {
    const parsed = new URL(trimmed);
    local = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return 'unconfigured';
  }
  if (local || models.some((model) => String(model).toLowerCase().includes('mock'))) return 'mock';
  return 'live';
}

function safeJson(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function extractToolCalls(parsed) {
  const msg = parsed?.choices?.[0]?.message;
  if (!msg) return [];
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    return msg.tool_calls.map((tc) => ({
      name: tc?.function?.name,
      args: safeJson(tc?.function?.arguments) ?? {},
    }));
  }
  const content = safeJson(msg.content);
  if (content && Array.isArray(content.tool_calls)) {
    return content.tool_calls.map((tc) => ({
      name: tc.tool ?? tc.function?.name,
      args: tc.args ?? safeJson(tc.function?.arguments) ?? {},
    }));
  }
  return [];
}

export function matchesExpectedSaleCall(call) {
  const args = call?.args;
  return call?.name === 'record_sale'
    && typeof args?.item === 'string'
    && args.item.includes('زيت عباد')
    && Number(args.qty) === 3
    && Number(args.amount) === 255;
}

export function allAcceptanceChecksPass(results) {
  return Array.isArray(results)
    && results.length > 0
    && results.every((model) => Array.isArray(model.checks)
      && model.checks.length > 0
      && model.checks.every((check) => check.id === 'A5' || check.pass === true));
}
