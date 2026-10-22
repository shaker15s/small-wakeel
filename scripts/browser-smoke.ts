// Real headless Chromium against the standalone build behind a local TLS proxy.
// Self-signed TLS is trusted ONLY by this test browser. No production auth or
// browser-web-security bypasses; no external mail/model/payment calls.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { chromium as playwright, expect as baseExpect, type Page } from '@playwright/test'
import chromium from '@sparticuz/chromium'
import { createClient } from '@libsql/client'
import { totp } from '../src/lib/saas/crypto'

const expect = baseExpect.configure({ timeout: 15_000 })

type Identity = { csrfToken: string; membershipId: string; account: { verified: boolean; mfaEnabled: boolean }; memberships: { id: string; businessId: string; userId: string; role: string }[] }
export async function browserSmoke(databaseUrl: string, key: string, boot: (origin: string) => Promise<string>) {
  const temp = mkdtempSync(join(tmpdir(), 'wakil-browser-'))
  const sql = createClient({ url: databaseUrl })
  await sql.execute('PRAGMA busy_timeout=10000')
  let upstream = ''
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { key: readFileSync(join(temp, 'key.pem')), cert: readFileSync(join(temp, 'cert.pem')) }, async fetch(req) {
    if (!upstream) return new Response(null, { status: 503 })
    const url = new URL(req.url), headers = new Headers(req.headers)
    headers.set('x-forwarded-host', url.host); headers.set('x-forwarded-proto', 'https'); headers.set('x-forwarded-for', '127.0.0.42')
    const response = await fetch(upstream + url.pathname + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual', signal: req.signal })
    const outgoing = new Headers(response.headers)
    outgoing.delete('content-encoding'); outgoing.delete('content-length'); outgoing.delete('transfer-encoding')
    return new Response(response.body, { status: response.status, headers: outgoing })
  } })
  const origin = `https://127.0.0.1:${proxy.port}`
  let browser: Awaited<ReturnType<typeof playwright.launch>> | undefined
  const errors: string[] = []
  async function identity(page: Page): Promise<Identity> { return page.evaluate(async () => { const r = await fetch('/api/auth/me'); if (!r.ok) throw new Error('Browser has no live identity'); return r.json() }) }
  async function link(to: string, action: string) {
    for (const row of (await sql.execute('SELECT payload FROM MailOutbox ORDER BY createdAt DESC')).rows) {
      if (!row.payload) continue
      const bytes = Buffer.from(String(row.payload).slice(9), 'base64'), decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      const mail = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString())
      if (mail.to === to && new URLSearchParams(new URL(mail.text).hash.slice(1)).get('action') === action) return mail.text as string
    }
    throw new Error('Missing encrypted fixture mail')
  }
  async function settings(page: Page) {
    if (await page.getByRole('heading', { name: 'حسابك ومساحة شغلك', exact: true }).isVisible()) return
    if ((page.viewportSize()?.width ?? 0) >= 640) {
      const dashboard = page.getByRole('button', { name: 'افتح لوحة اليوم', exact: true })
      if (!(await page.getByRole('button', { name: 'الإعدادات', exact: true }).isVisible())) {
        if (!(await dashboard.isVisible())) {
          await page.getByRole('button', { name: 'افتح شريط وكيل', exact: true }).hover()
          await expect(page.getByRole('toolbar', { name: 'شريط وكيل', exact: true })).toBeVisible()
          await page.getByRole('button', { name: 'ثبّت الشريط', exact: true }).click()
        }
        await dashboard.click()
      }
    }
    await page.getByRole('button', { name: 'الإعدادات', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'حسابك ومساحة شغلك', exact: true })).toBeVisible()
  }
  const panel = (page: Page) => page.locator('section[aria-labelledby="account-heading"]')
  try {
    upstream = await boot(origin)
    // Chromium's npm payload includes NSS libraries; unpack locally instead of
    // downloading a browser or apt packages from an unapproved host.
    const bin = join(dirname(require.resolve('@sparticuz/chromium')), '../bin')
    writeFileSync(join(temp, 'libraries.tar'), brotliDecompressSync(readFileSync(join(bin, 'al2023.tar.br'))))
    execFileSync('tar', ['-xf', join(temp, 'libraries.tar'), '-C', temp])
    browser = await playwright.launch({ executablePath: await chromium.executablePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], env: { ...process.env, LD_LIBRARY_PATH: [join(temp, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } })
    const options = { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'ar-EG', timezoneId: 'Africa/Cairo', reducedMotion: 'reduce' as const }
    const context = await browser.newContext(options)
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (e) => errors.push(e.message))
    const email = `browser-owner-${randomUUID()}@example.test`, staffEmail = `browser-staff-${randomUUID()}@example.test`, password = 'Browser test passphrase! 742'
    await page.goto(origin)
    await page.getByRole('button', { name: 'إنشاء حساب جديد', exact: true }).click()
    await page.getByLabel('البريد الإلكتروني', { exact: true }).fill(email)
    await page.getByLabel('اسمك', { exact: true }).fill('Browser owner')
    await page.getByLabel('اسم المنشأة', { exact: true }).fill('Browser blank workspace')
    await page.getByLabel('كلمة المرور', { exact: true }).fill(password)
    await page.getByLabel('تأكيد كلمة المرور', { exact: true }).fill(password)
    const [ownerSignup] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/auth/register') && r.request().method() === 'POST'), page.getByRole('button', { name: 'إنشاء حساب ومنشأة', exact: true }).click()])
    assert.equal(ownerSignup.status(), 200)
    await expect(page.getByText('حسابك اتعمل.', { exact: false })).toBeVisible()
    const initial = await identity(page), home = initial.memberships[0]
    assert.equal(initial.account.verified, false)
    const cookies = await context.cookies()
    const cookie = cookies.find((c) => c.name === '__Host-wakil_session')
    assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Lax')
    assert.equal(await page.evaluate(() => document.cookie.includes('wakil_session')), false)
    assert.equal(await page.evaluate(() => [localStorage.getItem('wakil.token'), sessionStorage.getItem('wakil.token')].some(Boolean)), false)
    assert.equal(await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status), 403)
    await page.goto(await link(email, 'verify'))
    try { await page.getByRole('button', { name: 'تأكيد البريد', exact: true }).click() }
    catch (error) {
      // Safe diagnostics: no URL fragments, form values, email payloads or tokens.
      console.error('Verification navigation diagnostics', { errors, headings: await page.locator('h1,h2').allTextContents(), buttons: await page.getByRole('button').allTextContents(), config: await page.evaluate(async () => { const r = await fetch('/api/auth/config'); return { status: r.status, config: r.ok ? await r.json() : null } }) })
      throw error
    }
    await expect(page.getByRole('status').filter({ hasText: 'تم تأكيد البريد' })).toBeVisible()
    await page.getByRole('button', { name: 'الرجوع إلى وكيل', exact: true }).click()

    // The real first-run journey now has four stages, including the persisted
    // owner interview. Drive the actual flow instead of waiting for the last
    // stage title immediately after returning from email verification.
    await expect(page.getByRole('heading', { name: 'معرفك — أنا «وكيل»', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'شوفه شغال', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'أول محادثة هتبقى كده', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'زبطني على شغلك', exact: true }).click()

    // Required facts are answered/skipped through the real API state machine.
    // Unknown opening cash must remain unknown, not become a synthetic zero.
    await expect(page.getByText('دلوقتي بتسجل البيع والشراء والتحصيل إزاي؟', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'ورقة وقلم', exact: true }).click()
    await expect(page.getByText('إيه الوحدات اللي بتتداول في شغلك؟ (اختار اللي يناسبك)', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'قطعة', exact: true }).click()
    await page.getByRole('button', { name: /تأكيد الاختيار/ }).click()
    await expect(page.getByText(/الخزنة بدأت بكام/)).toBeVisible()
    await page.getByRole('button', { name: /تخطي — هتفضل/ }).click()
    await expect(page.getByRole('button', { name: 'راجعت الملف — أكد وأكمل', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'راجعت الملف — أكد وأكمل', exact: true }).click()
    await expect(page.getByRole('button', { name: 'كمل للإعدادات', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'كمل للإعدادات', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'وكيل على مقاس شغلك', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'لون indigo', exact: true }).click()
    await page.getByLabel('الخزنة والسيولة', { exact: true }).check()
    await page.getByRole('button', { name: 'احفظ وابدأ ببياناتي الحقيقية', exact: true }).click()
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--analytics-accent').trim())).toBe('#4f46e5')
    const savedProfile = JSON.parse(String((await sql.execute({ sql: 'SELECT config FROM WorkspacePreference WHERE businessId=? AND userId=?', args: [home.businessId, home.userId] })).rows[0].config))
    assert.equal(savedProfile.onboardingComplete, true); assert.equal(savedProfile.accent, 'indigo')
    const profileRow = (await sql.execute({ sql: 'SELECT answers, openingCashStatedAt FROM BusinessProfile WHERE businessId=?', args: [home.businessId] })).rows[0]
    const profileAnswers = JSON.parse(String(profileRow.answers))
    assert.equal(profileRow.openingCashStatedAt, null, 'skipping opening cash must not write a fake zero')
    assert.equal(profileAnswers.openingCash.skipped, true)
    assert.equal(profileAnswers.openingCash.value, null)
    for (const table of ['Item', 'Customer', 'Supplier', 'Operation', 'CashEntry']) assert.equal(Number((await sql.execute({ sql: `SELECT COUNT(*) n FROM ${table} WHERE businessId=?`, args: [home.businessId] })).rows[0].n), 0)
    await page.getByRole('button', { name: 'تفكير أعمق', exact: true }).click()
    await expect.poll(async () => JSON.parse(String((await sql.execute({ sql: 'SELECT config FROM WorkspacePreference WHERE businessId=? AND userId=?', args: [home.businessId, home.userId] })).rows[0].config)).responseMode).toBe('deep')
    await page.getByRole('button', { name: '⚡ سريع', exact: true }).click()
    await expect.poll(async () => JSON.parse(String((await sql.execute({ sql: 'SELECT config FROM WorkspacePreference WHERE businessId=? AND userId=?', args: [home.businessId, home.userId] })).rows[0].config)).responseMode).toBe('fast')
    console.log('PASS: real onboarding persists scoped preferences without seeding money/catalog/parties; analytics token and fast/deep controls persist')
    // Test-only SpeechRecognition double: UI/lifecycle proof, NOT live microphone/ASR proof.
    const nativeSpeechAvailable = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      const native = w.SpeechRecognition ?? w.webkitSpeechRecognition
      w.__nativeSpeechRecognition = w.SpeechRecognition; w.__nativeWebkitSpeechRecognition = w.webkitSpeechRecognition
      class DictationFixture {
        lang = ''; continuous = false; interimResults = false
        onresult?: (e: unknown) => void; onerror?: (e: unknown) => void; onend?: () => void
        start() { w.__dictationFixture = this }
        stop() { this.onend?.() }
      }
      w.SpeechRecognition = DictationFixture
      return Boolean(native)
    })
    let voiceSubmits = 0
    const countVoice = (r: import('@playwright/test').Request) => { if (new URL(r.url()).pathname === '/api/chat' && r.method() === 'POST') voiceSubmits++ }
    page.on('request', countVoice)
    await page.getByRole('button', { name: 'تحدث بالصوت مع وكيل', exact: true }).click()
    await expect(page.getByRole('button', { name: 'إيقاف التسجيل الصوتي', exact: true })).toHaveAttribute('aria-pressed', 'true')
    assert.deepEqual(await page.evaluate(() => { const r = (window as any).__dictationFixture; return [r.lang, r.continuous, r.interimResults] }), ['ar-EG', false, true])
    await page.evaluate(() => (window as any).__dictationFixture.onresult({ results: [[{ transcript: 'باقي في الخزنة ٢٥٠' }]] }))
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toHaveValue('باقي في الخزنة ٢٥٠')
    await page.evaluate(() => (window as any).__dictationFixture.onresult({ results: [[{ transcript: 'باقي في الخزنة ٢٥٠٠' }]] }))
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toHaveValue('باقي في الخزنة ٢٥٠٠')
    assert.equal(voiceSubmits, 0, 'dictation must never auto-submit a money command')
    await page.getByRole('button', { name: 'إيقاف التسجيل الصوتي', exact: true }).click()
    await page.evaluate(() => (window as any).__dictationFixture.onresult({ results: [[{ transcript: 'late callback must be ignored' }]] }))
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toHaveValue('باقي في الخزنة ٢٥٠٠')
    await page.getByRole('button', { name: 'تحدث بالصوت مع وكيل', exact: true }).click()
    await page.evaluate(() => (window as any).__dictationFixture.onerror({ error: 'not-allowed' }))
    await expect(page.getByRole('button', { name: 'تحدث بالصوت مع وكيل', exact: true })).toBeVisible()
    await expect(page.getByText('اسمح بالوصول للميكروفون من إعدادات المتصفح', { exact: true }).first()).toBeVisible()
    page.off('request', countVoice)
    await page.evaluate(() => { const w = window as any; w.SpeechRecognition = w.__nativeSpeechRecognition; w.webkitSpeechRecognition = w.__nativeWebkitSpeechRecognition; delete w.__dictationFixture })
    console.log(`PASS: browser dictation UI/lifecycle (synthetic recognition events), Arabic locale, interim/final replacement, permission error, late callbacks, no auto-send; native API present=${nativeSpeechAvailable}; live microphone/ASR NOT VERIFIED`)
    let audioUploads = 0
    const countAudio = (r: import('@playwright/test').Request) => { if (new URL(r.url()).pathname === '/api/speech' && r.method() === 'POST') audioUploads++ }
    page.on('request', countAudio)
    await page.getByRole('button', { name: 'تسجيل ومراجعة', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('button', { name: 'ابدأ التسجيل', exact: true })).toBeDisabled()
    await expect(page.getByText(/خدمة تحويل التسجيل لسه مش متوصلة/)).toBeVisible()
    await page.getByRole('button', { name: 'إلغاء ومسح التسجيل', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    assert.equal(audioUploads, 0, 'opening or canceling recorder must never upload audio')
    page.off('request', countAudio)
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toHaveValue('باقي في الخزنة ٢٥٠٠')
    console.log('PASS: recorder consent/cancel UI, truthful unconfigured-ASR state, preserved draft, no automatic audio upload; live microphone/ASR NOT VERIFIED')
    // Owner explicitly reviews/approves the physical drawer count. No demo cash injected.
    // Capture the real response + isolated tenant state if the card fails to render;
    // this prevents a browser timeout from hiding whether parsing, drafting, or UI failed.
    const countInput = page.getByLabel('رسالة إلى وكيل', { exact: true })
    const countResponsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/chat' && response.request().method() === 'POST',
    )
    await countInput.press('Enter')
    const countResponse = await countResponsePromise
    try {
      await page.getByRole('button', { name: /اعتماد العملية/ }).click()
    } catch (error) {
      const conv = (await sql.execute({
        sql: 'SELECT id, title FROM Conversation WHERE businessId=? AND userId=? ORDER BY updatedAt DESC LIMIT 1',
        args: [home.businessId, home.userId],
      })).rows[0]
      const diagnostic = conv ? {
        httpStatus: countResponse.status(),
        workflowMode: (await sql.execute({ sql: 'SELECT workflowMode FROM Business WHERE id=?', args: [home.businessId] })).rows[0]?.workflowMode,
        profile: (await sql.execute({ sql: 'SELECT answers, openingCashStatedAt FROM BusinessProfile WHERE businessId=?', args: [home.businessId] })).rows[0] ?? null,
        messages: (await sql.execute({
          sql: 'SELECT role, text, card, actions FROM Message WHERE conversationId=? ORDER BY createdAt DESC LIMIT 4',
          args: [String(conv.id)],
        })).rows.map((r) => ({ role: r.role, text: r.text, card: r.card, actions: r.actions })),
        operations: (await sql.execute({
          sql: 'SELECT ref, type, status, summary, payload FROM Operation WHERE businessId=? ORDER BY createdAt DESC LIMIT 4',
          args: [home.businessId],
        })).rows,
        dialogue: (await sql.execute({
          sql: 'SELECT state, expiresAt FROM CashbookDialogue WHERE conversationId=?',
          args: [String(conv.id)],
        })).rows,
        visibleActionButtons: await page.getByRole('button').allTextContents(),
        assistantText: await page.locator('[data-message-role="assistant"]').allTextContents(),
      } : { httpStatus: countResponse.status(), conversation: null }
      console.error('Cash-count browser diagnostics (synthetic tenant only)', JSON.stringify(diagnostic))
      throw error
    }
    await expect.poll(async () => Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM CashbookEntry WHERE businessId=? AND kind='cash_count'", args: [home.businessId] })).rows[0].n)).toBe(1)
    assert.equal(Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM Operation WHERE businessId=? AND type='sale'", args: [home.businessId] })).rows[0].n), 0)
    console.log('PASS: real cashbook count approved in browser, persisted as unclassified reconciliation, never a sale')
    let chatRequests = 0
    const countChat = (request: import('@playwright/test').Request) => { if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST') chatRequests++ }
    page.on('request', countChat)
    await page.getByLabel('رسالة إلى وكيل', { exact: true }).fill('ضيف مصروف ٣٣ جنيه بند صيانة')
    await page.getByLabel('رسالة إلى وكيل', { exact: true }).press('Enter')
    await page.getByLabel('رسالة إلى وكيل', { exact: true }).press('Enter')
    await page.getByRole('button', { name: /اعتماد العملية/ }).click()
    await expect.poll(async () => Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM Operation WHERE businessId=? AND status='SUCCEEDED'", args: [home.businessId] })).rows[0].n)).toBe(2)
    const op = (await sql.execute({ sql: "SELECT id,ref FROM Operation WHERE businessId=? AND (type='expense' OR json_extract(payload,'$.kind')='expense')", args: [home.businessId] })).rows[0]
    assert.equal(Number((await sql.execute({ sql: 'SELECT COUNT(*) n FROM CashEntry WHERE ref=?', args: [op.ref] })).rows[0].n), 1)
    assert.equal(chatRequests, 1, 'rapid Enter does not double-submit or queue the same draft')
    page.off('request', countChat)
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError') } } }) })
    await page.getByRole('button', { name: 'انسخ الرد', exact: true }).last().click()
    await expect(page.getByRole('button', { name: 'تعذّر النسخ — اضغط للمحاولة تاني', exact: true })).toBeVisible()
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }) })
    await page.getByRole('button', { name: 'تعذّر النسخ — اضغط للمحاولة تاني', exact: true }).click()
    await expect(page.getByRole('button', { name: 'اتنسخ', exact: true })).toBeVisible()
    console.log('PASS: rapid keyboard send creates one request/draft; clipboard denial and successful retry have visible states')
    const retryTurn = randomUUID(), live = await identity(page)
    const interrupted = await page.evaluate(async ({ home, csrf, turnId }) => {
      const abort = new AbortController()
      const response = await fetch('/api/chat', { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json', 'x-wakil-csrf': csrf }, body: JSON.stringify({ businessId: home.businessId, userId: home.userId, turnId, text: 'ضيف مصروف ١٧ جنيه بند نظافة' }) })
      if (!response.ok || !response.body) throw new Error('Interrupted SSE did not start')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let text = ''
      while (!text.includes('"event":"start"')) {
        const chunk = await reader.read(); if (chunk.done) throw new Error('SSE ended before start')
        text += decoder.decode(chunk.value)
      }
      const start = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).find((e) => e.event === 'start')
      const completed = text.includes('"event":"done"')
      abort.abort(); await reader.cancel().catch(() => {})
      return { messageId: start.messageId as string, conversationId: start.conversationId as string, completed }
    }, { home, csrf: live.csrfToken, turnId: retryTurn })
    assert.equal(interrupted.completed, false, 'cancel before browser receives completion')
    await expect.poll(async () => Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM Message WHERE conversationId=? AND role='assistant' AND rowid > (SELECT rowid FROM Message WHERE id=?)", args: [interrupted.conversationId, interrupted.messageId] })).rows[0].n)).toBe(1)
    const replay = await page.evaluate(async ({ home, csrf, turnId, conversationId }) => {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wakil-csrf': csrf }, body: JSON.stringify({ businessId: home.businessId, userId: home.userId, turnId, conversationId, text: 'ضيف مصروف ١٧ جنيه بند نظافة' }) })
      return { status: response.status, body: await response.text() }
    }, { home, csrf: live.csrfToken, turnId: retryTurn, conversationId: interrupted.conversationId })
    assert.equal(replay.status, 200); assert.ok(replay.body.includes('"replayed":true'))
    assert.equal(Number((await sql.execute({ sql: 'SELECT COUNT(*) n FROM Message WHERE clientTurnId=?', args: [retryTurn] })).rows[0].n), 1)
    assert.equal(Number((await sql.execute({ sql: 'SELECT COUNT(*) n FROM Operation WHERE businessId=?', args: [home.businessId] })).rows[0].n), 3)
    assert.equal(Number((await sql.execute({ sql: 'SELECT COUNT(*) n FROM CashEntry WHERE businessId=?', args: [home.businessId] })).rows[0].n), 2)
    console.log('PASS: browser SSE canceled after start, server persisted one reply/draft, same-turn retry replayed without a second financial effect')
    await settings(page)
    await page.getByRole('button', { name: 'اليوم', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'دفتر المحل', exact: true })).toBeVisible()
    await expect(page.getByLabel('عدّ الخزنة / قفل اليوم', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(async () => { const r = await fetch('/api/cashbook'); return (await r.json()).cash }), 246700)
    await page.locator('details').filter({ hasText: 'راجع العملية' }).first().locator('summary').click()
    await page.getByRole('button', { name: /اعتماد العملية/ }).click()
    await expect.poll(async () => Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM Operation WHERE businessId=? AND status='SUCCEEDED'", args: [home.businessId] })).rows[0].n)).toBe(3)
    await expect(page.locator('details').filter({ hasText: 'راجع العملية' })).toHaveCount(0)
    const closeNotice = page.getByRole('button', { name: 'إغلاق التنبيه', exact: true })
    if (await closeNotice.isVisible()) await closeNotice.click()
    mkdirSync(join(process.cwd(), '.ci-results'), { recursive: true })
    await page.getByRole('heading', { name: 'دفتر المحل', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(process.cwd(), '.ci-results/cashbook-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByLabel('عدّ الخزنة / قفل اليوم', { exact: true })).toBeVisible()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'cashbook mobile RTL has no horizontal overflow')
    const hero = await page.getByLabel('خزنة المحل', { exact: true }).boundingBox()
    const countButton = await page.getByRole('button', { name: 'راجع العدّ', exact: true }).boundingBox()
    assert.ok(hero && countButton && countButton.x >= hero.x && countButton.x + countButton.width <= hero.x + hero.width, 'count action fits inside mobile hero; overflow-hidden must not hide a clipped control')
    await page.getByRole('heading', { name: 'دفتر المحل', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(process.cwd(), '.ci-results/cashbook-mobile.png'), fullPage: true })
    await page.setViewportSize(options.viewport)
    console.log('PASS: real cashbook Today desktop/mobile RTL, recorded cash, inline review/approval refresh, and screenshots')
    // Real UI → real SSE → approved bookkeeping, no model fixture. Only the duplicate
    // master-data rows below are explicit synthetic fixtures on this disposable DB.
    await page.getByRole('button', { name: 'افتح التفاصيل', exact: true }).click()
    const compose = page.getByLabel('رسالة إلى وكيل', { exact: true })
    await expect(compose).toBeVisible()
    await compose.fill('بعت لمريم بضاعة بمية على الحساب امبارح وهيسدد بكرة'); await compose.press('Enter')
    await expect(page.getByRole('button', { name: /اعتماد العملية/ })).toBeVisible()
    const oldDraft = (await sql.execute({ sql: "SELECT id,ref FROM Operation WHERE businessId=? AND status='AWAITING_APPROVAL' AND json_extract(payload,'$.partyName')='مريم'", args: [home.businessId] })).rows[0]
    assert.ok(oldDraft)
    await compose.fill('المبلغ مش مية هو مية وعشرين'); await compose.press('Enter')
    await expect.poll(async () => String((await sql.execute({ sql: 'SELECT status FROM Operation WHERE id=?', args: [oldDraft.id] })).rows[0].status)).toBe('CANCELLED')
    await expect(page.getByRole('button', { name: /اعتماد العملية/ })).toHaveCount(1)
    await page.getByRole('button', { name: /اعتماد العملية/ }).click()
    await expect.poll(async () => Number((await sql.execute({ sql: "SELECT balance FROM Customer WHERE businessId=? AND name='مريم'", args: [home.businessId] })).rows[0]?.balance)).toBe(12000)
    assert.equal(Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM CashEntry WHERE ref=?", args: [oldDraft.ref] })).rows[0].n), 0)
    const choiceA = randomUUID(), choiceB = randomUUID()
    for (const [id, phone] of [[choiceA, '01077777771'], [choiceB, '01077777772']]) await sql.execute({ sql: 'INSERT INTO Customer (id,businessId,name,phone,balance,createdAt) VALUES (?,?,?,?,?,?)', args: [id, home.businessId, 'عميل اختبار اختيار', phone, 0, Date.now()] })
    await compose.fill('بعت لعميل اختبار اختيار بضاعة بمية على الحساب النهارده'); await compose.press('Enter')
    const choiceButton = page.getByRole('button', { name: /01077777772/ })
    await expect(choiceButton).toBeEnabled()
    await choiceButton.click()
    await expect(page.getByRole('button', { name: /اعتماد العملية/ })).toBeVisible()
    await expect(choiceButton).toBeDisabled()
    await page.getByRole('button', { name: /اعتماد العملية/ }).click()
    await expect.poll(async () => Number((await sql.execute({ sql: 'SELECT balance FROM Customer WHERE id=?', args: [choiceB] })).rows[0].balance)).toBe(10000)
    assert.equal(Number((await sql.execute({ sql: 'SELECT balance FROM Customer WHERE id=?', args: [choiceA] })).rows[0].balance), 0)
    assert.equal(await page.evaluate(async () => { const r = await fetch('/api/cashbook'); return (await r.json()).cash }), 245000)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'clarification buttons fit mobile RTL')
    const notice = page.getByRole('button', { name: 'إغلاق التنبيه', exact: true })
    if (await notice.isVisible()) await notice.click()
    assert.ok(await page.locator('dl dd').evaluateAll(els => els.every(el => el.scrollWidth <= el.clientWidth + 1)), 'financial field values must not be clipped even if the surrounding chat hides overflow')
    assert.ok(await page.locator('dl dt').evaluateAll(els => els.every(el => el.scrollWidth <= el.clientWidth + 1)), 'field hints must wrap within their column')
    await page.screenshot({ path: join(process.cwd(), '.ci-results/cashbook-clarification-mobile.png'), fullPage: true })
    await page.setViewportSize(options.viewport)
    console.log('PASS: browser spoken-number credit, explicit correction cancels old draft, one replacement approval, nonce-bound duplicate-party buttons, stale buttons disabled, selected account only; cash unchanged')

    // Contextual shopping memory is not a purchase or a receipt. Exercise the
    // same real chat transport and Today CTA, including a page reload.
    const shopBefore = (await sql.execute({ sql: 'SELECT COUNT(*) n FROM Operation WHERE businessId=?', args: [home.businessId] })).rows[0].n
    await compose.fill('فكرني أجيب البيض مع البضاعة'); await compose.press('Enter')
    await expect.poll(async () => Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM ShopReminder WHERE businessId=? AND userId=? AND active=1 AND subject='البيض'", args: [home.businessId, home.userId] })).rows[0].n)).toBe(1)
    await compose.fill('فكرني أجيب أكياس تعبئة المقاس الكبير للمحل مع البضاعة'); await compose.press('Enter')
    await expect.poll(async () => Number((await sql.execute({ sql: 'SELECT COUNT(*) n FROM ShopReminder WHERE businessId=? AND userId=? AND active=1', args: [home.businessId, home.userId] })).rows[0].n)).toBe(2)
    await settings(page)
    await page.getByRole('button', { name: 'اليوم', exact: true }).click()
    const brief = page.getByRole('region', { name: 'ابدأ يومك', exact: true })
    await expect(brief.getByText('افتكر النواقص مع البضاعة الجاية', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'manual-shop followup card wraps on mobile')
    await brief.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(process.cwd(), '.ci-results/cashbook-followups-mobile.png'), fullPage: true })
    await brief.getByRole('button', { name: 'راجع قائمة النواقص', exact: true }).click()
    const gotEggs = page.getByRole('button', { name: 'جبت البيض', exact: true })
    await expect(gotEggs).toBeEnabled()
    await gotEggs.click()
    await expect.poll(async () => Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM ShopReminder WHERE businessId=? AND userId=? AND active=1 AND subject='البيض'", args: [home.businessId, home.userId] })).rows[0].n)).toBe(0)
    await expect(gotEggs).toBeDisabled()
    const bagsName = 'جبت أكياس تعبئة المقاس الكبير للمحل'
    await expect(page.getByRole('button', { name: bagsName, exact: true }).last()).toBeEnabled()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'restock reply buttons fit mobile RTL')
    await page.reload()
    await expect(page.getByRole('button', { name: bagsName, exact: true }).last()).toBeEnabled()
    const postpone = page.getByRole('button', { name: 'لسه محتاجهم', exact: true }).last()
    await postpone.click()
    await expect(postpone).toBeDisabled()
    await expect(page.locator('[data-message-role="user"]').filter({ hasText: /اختيار [a-z0-9-]+ رقم/ })).toHaveCount(0)
    assert.ok(Number((await sql.execute({ sql: "SELECT COUNT(*) n FROM Message WHERE conversationId IN (SELECT id FROM Conversation WHERE businessId=?) AND role='user' AND text LIKE 'اختيار % رقم %'", args: [home.businessId] })).rows[0].n) > 0, 'audit/transport keeps the real nonce; only presentation uses the selected label')
    assert.equal(Number((await sql.execute({ sql: 'SELECT COUNT(*) n FROM ShopReminder WHERE businessId=? AND userId=? AND active=1', args: [home.businessId, home.userId] })).rows[0].n), 1)
    assert.equal((await sql.execute({ sql: 'SELECT COUNT(*) n FROM Operation WHERE businessId=?', args: [home.businessId] })).rows[0].n, shopBefore)
    assert.equal(await page.evaluate(async () => { const r = await fetch('/api/cashbook'); return (await r.json()).cash }), 245000)
    await page.screenshot({ path: join(process.cwd(), '.ci-results/cashbook-restock-mobile.png'), fullPage: true })
    await page.setViewportSize(options.viewport)
    console.log('PASS: personal restock memory → real manual-shop Today review CTA → nonce-bound item completion → reload → postpone; no purchase, receipt, money or stock inferred')

    await settings(page)
    await expect(page.getByRole('button', { name: 'إضافة مزوّد جديد', exact: false })).toHaveCount(0)
    await panel(page).getByLabel('بريد الموظف المدعو').fill(staffEmail)
    await panel(page).getByRole('button', { name: 'إرسال دعوة', exact: true }).click()
    await expect(panel(page).getByText(staffEmail, { exact: true })).toBeVisible()
    const staffContext = await browser.newContext(options)
    await staffContext.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const staff = await staffContext.newPage(); staff.setDefaultTimeout(15000); staff.on('pageerror', (e) => errors.push(e.message))
    await staff.goto(await link(staffEmail, 'invite'))
    await staff.getByRole('button', { name: 'إنشاء حساب جديد', exact: true }).click()
    await expect(staff.getByLabel('اسم المنشأة', { exact: true })).toHaveCount(0)
    await staff.getByLabel('البريد الإلكتروني', { exact: true }).fill(staffEmail)
    await staff.getByLabel('اسمك', { exact: true }).fill('Browser cashier')
    await staff.getByLabel('كلمة المرور', { exact: true }).fill(password)
    await staff.getByLabel('تأكيد كلمة المرور', { exact: true }).fill(password)
    const [staffSignup] = await Promise.all([staff.waitForResponse((r) => r.url().endsWith('/api/auth/register') && r.request().method() === 'POST'), staff.getByRole('button', { name: 'إنشاء حساب والانضمام للفريق', exact: true }).click()])
    assert.equal(staffSignup.status(), 200)
    await staff.getByRole('button', { name: 'احفظ وابدأ ببياناتي الحقيقية', exact: true }).click()
    await expect(staff.getByLabel('رسالة إلى وكيل', { exact: true })).toBeVisible()
    await expect.poll(async () => staff.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--analytics-accent').trim())).toBe('#b45309')
    const employee = await identity(staff)
    assert.equal(employee.memberships.length, 1); assert.equal(employee.memberships[0].role, 'cashier'); assert.equal(employee.account.verified, true)
    assert.equal(staff.url().includes('#'), false)
    await settings(staff)
    await expect(panel(staff).getByText('الفريق والصلاحيات', { exact: true })).toHaveCount(0)
    const forbidden = await staff.evaluate(async ({ id, userId, csrf }) => (await fetch(`/api/operations/${id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wakil-csrf': csrf }, body: JSON.stringify({ action: 'approve', userId }) })).status, { id: String(op.id), userId: employee.memberships[0].userId, csrf: employee.csrfToken })
    assert.equal(forbidden, 403)
    await page.getByText('إنشاء منشأة أخرى', { exact: true }).click()
    await panel(page).getByLabel('اسم المنشأة الجديدة').fill('Browser second workspace')
    await panel(page).getByRole('button', { name: 'إنشاء مساحة فارغة', exact: true }).click()
    await page.getByRole('button', { name: 'احفظ وابدأ ببياناتي الحقيقية', exact: true }).click()
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toBeVisible()
    const second = await identity(page)
    assert.equal(second.memberships.length, 2); assert.notEqual(second.membershipId, home.id)
    const secondBusiness = second.memberships.find((m) => m.id === second.membershipId)!.businessId
    assert.equal(await staff.evaluate(async (id) => (await fetch(`/api/items?businessId=${id}`)).status, secondBusiness), 403)
    await settings(page)
    await panel(page).getByLabel('اختيار المنشأة').selectOption(home.id)
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toBeVisible()
    assert.equal((await identity(page)).membershipId, home.id)
    await settings(page)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile must not overflow horizontally')
    await expect(panel(page).getByRole('heading', { name: 'حسابك ومساحة شغلك' })).toBeVisible()
    await page.setViewportSize(options.viewport)
    await page.reload(); await settings(page) // refresh team after employee joined
    page.once('dialog', (d) => d.accept())
    await panel(page).locator('li').filter({ hasText: staffEmail }).getByRole('button', { name: 'إيقاف', exact: true }).click()
    await expect.poll(async () => staff.evaluate(async () => (await fetch('/api/auth/me')).status)).toBe(401)
    await staff.reload()
    await expect(staff.getByLabel('البريد الإلكتروني', { exact: true })).toBeVisible()
    await panel(page).getByLabel('كلمة المرور الحالية لتغيير إعدادات الأمان').fill(password)
    await panel(page).getByRole('button', { name: 'تفعيل التحقق بخطوتين', exact: true }).click()
    const secret = await panel(page).locator('code').innerText()
    await panel(page).getByLabel('رمز جديد من تطبيق المصادقة أو كود استرداد').fill(totp(secret, Math.floor(Date.now() / 30_000)))
    await panel(page).getByRole('button', { name: 'تأكيد التحقق بخطوتين', exact: true }).click()
    await expect(panel(page).locator('pre')).toBeVisible()
    const recovery = (await panel(page).locator('pre').innerText()).trim().split('\n')
    assert.equal(recovery.length, 10)
    await panel(page).getByRole('button', { name: 'حفظتها — إخفاء الأكواد', exact: true }).click()
    await expect(panel(page).locator('pre')).toHaveCount(0)
    await panel(page).getByRole('button', { name: 'تسجيل الخروج', exact: true }).click()
    await page.getByRole('button', { name: 'نسيت كلمة المرور؟', exact: true }).click()
    await page.getByLabel('البريد الإلكتروني', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'إرسال رابط الاستعادة', exact: true }).click()
    await expect(page.getByRole('status')).toBeVisible()
    const changed = 'Browser changed passphrase! 829'
    await page.goto(await link(email, 'reset'))
    await page.getByLabel('كلمة المرور', { exact: true }).fill(changed)
    await page.getByLabel('تأكيد كلمة المرور', { exact: true }).fill(changed)
    await page.getByRole('button', { name: 'حفظ كلمة المرور', exact: true }).click()
    await expect(page.getByRole('status')).toBeVisible()
    await page.getByRole('button', { name: 'الرجوع إلى وكيل', exact: true }).click()
    await page.getByLabel('البريد الإلكتروني', { exact: true }).fill(email)
    await page.getByLabel('كلمة المرور', { exact: true }).fill(changed)
    await page.getByRole('button', { name: 'دخول آمن', exact: true }).click()
    await page.getByLabel('رمز تطبيق المصادقة أو كود استرداد').fill(recovery[0])
    await page.getByRole('button', { name: 'دخول آمن', exact: true }).click()
    await expect(page.getByLabel('رسالة إلى وكيل', { exact: true })).toBeVisible()
    assert.equal((await identity(page)).account.mfaEnabled, true)
    await settings(page)
    await panel(page).getByText('الجلسات النشطة', { exact: true }).click()
    await panel(page).getByRole('button', { name: 'تسجيل الخروج من كل الأجهزة', exact: true }).click()
    await expect(page.getByLabel('البريد الإلكتروني', { exact: true })).toBeVisible()
    assert.deepEqual(errors, [], 'no unhandled browser runtime errors')
    console.log('PASS: real Chromium UI signup/verify/HttpOnly+Secure/CSRF/Arabic expense+approval/invited signup/cashier denial/tenant denial/workspace rotation/mobile RTL/MFA/recovery/reset/logout-all; encrypted fixture email, self-signed local TLS, no external delivery')
    await context.close(); await staffContext.close()
  } finally {
    await browser?.close()
    // Bun may keep the stop promise pending after an aborted streaming client;
    // force-close sockets without blocking teardown of the backend process.
    void proxy.stop(true)
    sql.close(); rmSync(temp, { recursive: true, force: true })
  }
}
