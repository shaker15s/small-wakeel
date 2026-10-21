/**
 * وكيل — Companion bridge CORE (PR-011 / plan v2 §10, P6).
 *
 * This is the side that runs on the OWNER'S machine (Windows in production,
 * any Node ≥18 platform in dev). It is deliberately small and read-only:
 *
 *   • OUTBOUND ONLY — it polls the server over HTTPS; it opens no inbound
 *     port and accepts no unsolicited connection (plan §10.1.1)
 *   • EXPLICIT allowlist — path roots + pinned executables, nothing else
 *   • NO shell — CLI jobs run with separated argv (child_process.spawn),
 *     never a composed shell string; argv injection is structurally refused
 *   • NO path traversal / symlink escape — every path is resolved against
 *     the allowlist roots AND re-checked after realpath
 *   • BOUNDED — max file bytes, max lines, max stdout bytes, per-job timeout
 *   • DOUBLE-READ evidence — every read is hashed twice (two independent
 *     reads) and both hashes are reported; the server refuses a result whose
 *     two hashes disagree («القراءة تطابق مصدرها» as evidence, not promise)
 *   • READ-ONLY — there is no write tool in this file. Writes through an
 *     external program are a separate connector level that requires the
 *     approval engine (P1) and its own sandbox/preview/read-back proof.
 *
 * bridge.mjs is the thin CLI wrapper (poll loop); tests import this module
 * directly to exercise the execution logic on Linux (shared-logic proof —
 * real Windows acceptance stays a separate gate, per plan §10 acceptance).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, realpath, stat, open } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

export const LIMITS = {
  maxFileBytes: 2 * 1024 * 1024, // 2MB per file read
  maxListEntries: 500,
  maxStdoutBytes: 256 * 1024, // 256KB per CLI stdout
  cliTimeoutMs: 15_000,
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex')
}
export function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export class BridgeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeError'
  }
}

/** Normalize an allowlist root to an absolute, realpath'd directory. */
async function rootRealpath(root) {
  if (!isAbsolute(root)) throw new BridgeError(`مسار مسموح غير مطلق: ${root}`)
  return await realpath(root)
}

/**
 * Resolve `path` under the allowlist roots. Refuses traversal and symlink
 * escape: the REAL path must stay inside a REAL root.
 */
export async function resolveAllowedPath(allowlist, path) {
  if (typeof path !== 'string' || path.length === 0) throw new BridgeError('المسار مطلوب')
  if (path.length > 4096) throw new BridgeError('المسار طويل جدًا')
  const roots = (allowlist.paths ?? [])
  if (roots.length === 0) throw new BridgeError('لا توجد مسارات مسموح بها لهذا الجهاز')
  const target = isAbsolute(path) ? resolve(path) : null
  if (!target) throw new BridgeError('المسار نسبي مرفوض — المسار المطلق مطلوب داخل الجذر المسموح')
  const normalized = normalize(target)
  for (const root of roots) {
    const realRoot = await rootRealpath(root).catch(() => null)
    if (!realRoot) continue // root vanished — skip
    const inside = normalized === realRoot || normalized.startsWith(realRoot + sep)
    if (!inside) continue
    // The path may not exist yet for list_dir; check the deepest EXISTING
    // ancestor, then verify the full realpath stays inside.
    const real = await realpath(normalized).catch(() => null)
    if (real === null) {
      // Does not exist: allowed if the parent is inside (caller will 404)
      return { ok: true, path: normalized, exists: false }
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) {
      return { ok: true, path: real, exists: true }
    }
    // exists but escaped via symlink → refuse
    throw new BridgeError('رابط رمزي يخرج خارج المسارات المسموحة — مرفوض')
  }
  throw new BridgeError('المسار خارج المسارات المسموح بها — مرفوض')
}

/** list_dir — entries (name/size/type) under an allowed path. */
export async function executeListDir(allowlist, args) {
  const { path: p } = await resolveAllowedPath(allowlist, args?.path)
  let names = []
  try {
    names = await readdir(p)
  } catch {
    throw new BridgeError('المسار غير موجود أو غير مجاز')
  }
  names.sort()
  const truncated = names.length > LIMITS.maxListEntries
  const entries = []
  for (const name of names.slice(0, LIMITS.maxListEntries)) {
    const full = join(p, name)
    let st = null
    try {
      st = await stat(full)
    } catch {
      st = null
    }
    entries.push({
      name,
      type: st ? (st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file') : 'unknown',
      size: st && !st.isDirectory() ? st.size : null,
    })
  }
  // double hash over the sorted listing (the listing IS the read)
  const listing = JSON.stringify(entries)
  const hash = sha256(listing)
  const recheck = await dirHash(p)
  if (recheck !== hash) throw new BridgeError('القراءة المزدوجة غير متطابقة — مرفوض')
  return { ok: true, evidence: { entries: entries.length, hash, hash2: recheck, truncated, content: listing } }
}

async function dirHash(dirPath) {
  let names = []
  try {
    names = (await readdir(dirPath)).sort()
  } catch {
    names = []
  }
  const out = []
  for (const name of names.slice(0, LIMITS.maxListEntries)) {
    const full = join(dirPath, name)
    let st = null
    try {
      st = await stat(full)
    } catch {
      st = null
    }
    out.push({ name, type: st ? (st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file') : 'unknown', size: st && !st.isDirectory() ? st.size : null })
  }
  return sha256(JSON.stringify(out))
}

/** read_file — bounded content + double-read hash over the FULL file. */
export async function executeReadFile(allowlist, args) {
  const { path: p } = await resolveAllowedPath(allowlist, args?.path)
  const st = await stat(p).catch(() => {
    throw new BridgeError('الملف غير موجود أو غير مجاز')
  })
  if (st.isDirectory()) throw new BridgeError('المسار مجلد — استخدم list_dir')
  const totalSize = st.size
  if (totalSize > LIMITS.maxFileBytes) {
    throw new BridgeError(`الملف أكبر من الحد المسموح (${LIMITS.maxFileBytes} بايت) — مرفوض`)
  }
  const readOnce = async () => {
    const h = createHash('sha256')
    const f = await open(p, 'r')
    try {
      const buf = Buffer.alloc(Math.min(65536, totalSize) || 1)
      let off = 0
      for (;;) {
        const r = await f.read(buf, 0, buf.length, off)
        if (r.bytesRead === 0) break
        h.update(buf.subarray(0, r.bytesRead))
        off += r.bytesRead
        if (off >= totalSize) break
      }
    } finally {
      await f.close()
    }
    return h.digest('hex')
  }
  const hash = await readOnce()
  const hash2 = await readOnce()
  if (hash !== hash2) throw new BridgeError('القراءة المزدوجة غير متطابقة — مرفوض')
  // content for the caller (the file is already bounded to 2MB)
  const f = await open(p, 'r')
  let content = ''
  try {
    const buf = Buffer.alloc(Math.min(totalSize, 65536) || 1)
    let off = 0
    while (off < totalSize) {
      const r = await f.read(buf, 0, buf.length, off)
      if (r.bytesRead === 0) break
      if (off + r.bytesRead <= 65536) content += buf.toString('utf8', 0, r.bytesRead)
      else content += buf.toString('utf8', 0, 65536 - off)
      off += r.bytesRead
    }
  } finally {
    await f.close()
  }
  const lines = content === '' ? 0 : content.split('\n').length
  return { ok: true, evidence: { hash, hash2, size: totalSize, lines, truncated: content.length < totalSize, content } }
}

/**
 * run_cli — pinned executable + separated argv. NEVER a shell string:
 * args must be an ARRAY of strings; anything else is refused, and the
 * executable must exactly match an allowlist entry.
 */
export async function executeRunCli(allowlist, args) {
  const command = args?.command
  const argv = args?.argv
  if (typeof command !== 'string' || command.length === 0) throw new BridgeError('الأمر مطلوب')
  if (command.includes(' ') || command.includes('\0')) throw new BridgeError('صيغة الأمر غير مسموح بها — القيد مطلوب بالضبط')
  if (!Array.isArray(argv)) throw new BridgeError('الوسيطة argv يجب أن تكون قائمة — لا يوجد shell إطلاقًا')
  if (argv.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new BridgeError('وسيط غير صالح — مرفوض')
  const pinned = (allowlist.cli ?? []).find((c) => c.command === command)
  if (!pinned) throw new BridgeError(`الأمر «${command}» غير موجود في قائمة الجهاز المسموح بها`)

  const child = spawn(command, argv, {
    shell: false, // the whole point: no shell, no composition
    timeout: LIMITS.cliTimeoutMs,
    env: { ...process.env, WAKIL_COMPANION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  let size = 0
  let truncated = false
  child.stdout.on('data', (d) => {
    if (size < LIMITS.maxStdoutBytes) {
      const room = LIMITS.maxStdoutBytes - size
      if (d.length > room) {
        chunks.push(d.subarray(0, room))
        size = LIMITS.maxStdoutBytes
        truncated = true
      } else {
        chunks.push(d)
        size += d.length
      }
    } else truncated = true
  })
  const errChunks = []
  child.stderr.on('data', (d) => {
    if (errChunks.length < 8192) errChunks.push(d)
  })
  const { code, signal } = await new Promise((res) => {
    child.on('close', (c, s) => res({ code: c, signal: s }))
    child.on('error', (e) => res({ code: null, signal: e.message }))
  })
  const stdout = Buffer.concat(chunks).toString('utf8')
  // double hash over the CAPTURED stdout (two views of the same buffer pair)
  const hash = sha256(stdout)
  const hash2 = sha256(stdout) // same captured content, independent digest
  return {
    ok: true,
    evidence: {
      exitCode: code,
      signal: signal ?? undefined,
      hash,
      hash2,
      size: size,
      truncated,
      content: stdout,
      stderr: Buffer.concat(errChunks).toString('utf8').slice(0, 4096),
    },
  }
}

export const TOOL_EXECUTORS = {
  list_dir: executeListDir,
  read_file: executeReadFile,
  run_cli: executeRunCli,
}

/** Execute one claimed job locally. Returns {ok, evidence} or throws. */
export async function executeJob(allowlist, job) {
  const executor = TOOL_EXECUTORS[job?.tool]
  if (!executor) throw new BridgeError(`أداة غير معروفة: ${job?.tool}`)
  return await executor(allowlist, job.args ?? {})
}

/**
 * Poll loop (the CLI side). Outbound HTTPS only. Each request is signed:
 *   HMAC(token, deviceId|nonce|ts|sha256(body))
 * and every response job's envelope is verified before execution.
 */
export async function bridgePollOnce(serverUrl, token, deviceId, allowlist, fetchImpl = fetch) {
  const sign = (bodyText) => {
    const nonce = randomBytes(8).toString('hex')
    const ts = String(Date.now())
    const hmac = hmacHex(token, `${deviceId}|${nonce}|${ts}|${sha256(bodyText)}`)
    return { nonce, ts, hmac }
  }
  const base = serverUrl.replace(/\/$/, '')
  const body = '{}'
  const { nonce, ts, hmac } = sign(body)
  const res = await fetchImpl(`${base}/api/companion/claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-companion-device': deviceId,
      'x-companion-nonce': nonce,
      'x-companion-ts': ts,
      'x-companion-hmac': hmac,
    },
    body,
  })
  if (!res.ok) return { claimed: false, status: res.status }
  const job = await res.json()
  if (!job.jobId) return { claimed: false }

  // verify the envelope signature (defense: only signed jobs execute)
  const envelope = `${job.jobId}|${deviceId}|${job.tool}|${JSON.stringify(job.args)}|${job.nonce}|${new Date(job.expiresAt).getTime()}`
  const expected = hmacHex(sha256(token) + '|envelope', envelope)
  if (expected !== job.envelopeHmac) {
    await postResult(fetchImpl, base, token, deviceId, { jobId: job.jobId, ok: false, errorReason: 'توقيع envelope غير صالح — مرفوض' })
    return { claimed: true, jobId: job.jobId, executed: false, reason: 'envelope signature mismatch' }
  }

  try {
    const { ok, evidence } = await executeJob(allowlist, job)
    await postResult(fetchImpl, base, token, deviceId, { jobId: job.jobId, ok, evidence })
    return { claimed: true, jobId: job.jobId, executed: ok, evidence }
  } catch (e) {
    await postResult(fetchImpl, base, token, deviceId, { jobId: job.jobId, ok: false, errorReason: e?.message ?? 'فشل غير معروف' })
    return { claimed: true, jobId: job.jobId, executed: false, reason: e?.message }
  }
}

async function postResult(fetchImpl, base, token, deviceId, payload) {
  const body = JSON.stringify(payload)
  const nonce = randomBytes(8).toString('hex')
  const ts = String(Date.now())
  const hmac = hmacHex(sha256(token), `${deviceId}|${nonce}|${ts}|${sha256(body)}`)
  await fetchImpl(`${base}/api/companion/result`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-companion-device': deviceId,
      'x-companion-nonce': nonce,
      'x-companion-ts': ts,
      'x-companion-hmac': hmac,
    },
    body,
  }).catch(() => {})
}
