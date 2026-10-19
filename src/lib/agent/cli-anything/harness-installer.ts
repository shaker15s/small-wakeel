import { execFile } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { promisify } from 'node:util'
import { db } from '@/lib/db'

const pExecFile = promisify(execFile)

export interface HarnessProbe {
  ok: boolean
  detail: string
}

export interface SkillCommand {
  command: string // full: "cli-anything-daftra invoice list"
  example?: string
}

export interface SkillMd {
  name: string
  app: string
  commands: SkillCommand[]
  raw: string
}

// ---------------------------------------------------------------------------
// R46 — MODE 2: the REAL CLI-Anything, integrated — not copied, not imitated.
//
// CLI-Anything (github.com/HKUDS/CLI-Anything) turns any app into an
// agent-operable CLI with a SKILL.md contract:
//
//   • CLI-Hub:  pip install cli-anything-hub  →  cli-hub list/search/install
//               (prebuilt harnesses for ~30 apps)
//   • 7-phase pipeline (opencode-commands/cli-anything.md):
//     P0 acquire real source (path/URL — names are rejected)
//     P1 analyze the codebase (GUI actions → API calls)
//     P2 design the CLI architecture (groups, state, output formats, SOP)
//     P3 implement (Click CLI + REPL, `--json` for agents, PEP-420
//        namespace cli_anything/<app>, console_scripts)
//     P4/P5 test plan + tests (no hardcoded paths, `which` verify)
//     P6 run the full suite, append results
//     P7 publish `cli-anything-<software>` to PyPI (or pip install -e .)
//
// Wakil's role: with the owner's EXPLICIT permission, run these real
// commands on the owner's machine, then parse the produced SKILL.md and
// register the executable surface in our AppHarness table — after which
// `cli_control_app` routes the app to the installed harness and the brain
// can drive the whole job alone, at CLI speed.
//
// Everything fails CLOSED and reports the honest state.

const PY = process.platform === 'win32' ? 'python' : 'python3'

async function runCmd(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<HarnessProbe> {
  try {
    const { stdout, stderr } = await pExecFile(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    return { ok: true, detail: (stdout || stderr).trim().slice(0, 2000) }
  } catch (e: any) {
    return { ok: false, detail: (e?.message || String(e)).slice(0, 300) }
  }
}

/** Is there a Python interpreter at all? (CLI-Anything is Python-native.) */
export async function pythonProbe(): Promise<HarnessProbe> {
  const p = await runCmd(PY, ['--version'], 8000)
  return p.ok
    ? { ok: true, detail: p.detail.split('\n')[0] }
    : { ok: false, detail: 'مفيش Python على الجهاز — CLI-Anything محتاج Python 3.9+' }
}

/** Is the real CLI-Hub installed? */
export async function cliHubProbe(): Promise<HarnessProbe & { version?: string }> {
  // cli-hub console script
  const direct = await runCmd('cli-hub', ['--version'], 8000)
  if (direct.ok) return { ok: true, detail: direct.detail.split('\n')[0], version: direct.detail.split('\n')[0] }
  // python -m cli_anything.hub
  const mod = await runCmd(PY, ['-m', 'cli_anything.hub', '--help'], 8000)
  if (mod.ok) return { ok: true, detail: 'module ok' }
  const show = await runCmd(PY, ['-m', 'pip', 'show', 'cli-anything-hub'], 10000)
  return show.ok
    ? { ok: true, detail: 'installed (module)' }
    : { ok: false, detail: 'cli-anything-hub مش متثبت — يُثبّت عند التأكيد: pip install cli-anything-hub' }
}

/** Search the real hub for an app's prebuilt harness. */
export async function hubSearch(app: string): Promise<HarnessProbe & { slug?: string }> {
  const q = app.trim().toLowerCase()
  for (const [cmd, args] of [
    ['cli-hub', ['search', q]],
    [PY, ['-m', 'cli_anything.hub', 'search', q]],
  ] as const) {
    const r = await runCmd(cmd, [...args], 15000)
    if (r.ok && /cli-anything-[a-z0-9-]+/i.test(r.detail)) {
      const m = r.detail.match(/cli-anything-([a-z0-9-]+)/i)
      return { ok: true, detail: r.detail.slice(0, 800), slug: m ? `cli-anything-${m[1]}` : undefined }
    }
  }
  return { ok: false, detail: `مفيش harness جاهز باسم «${q}» في الـ hub` }
}

/**
 * Install the real prebuilt harness from CLI-Hub (runs on the owner's
 * machine, with the owner's permission). Returns the path of the SKILL.md
 * it finds, or an honest failure.
 */
export async function hubInstall(slug: string): Promise<HarnessProbe & { skillMdPath?: string }> {
  const installs: Array<[string, string[]]> = [
    ['cli-hub', ['install', slug]],
    [PY, ['-m', 'cli_anything.hub', 'install', slug]],
  ]
  for (const [cmd, args] of installs) {
    const r = await runCmd(cmd, args, 240000) // pip installs can take a while
    if (!r.ok) continue
    const p = locateSkillMd(slug)
    if (p) return { ok: true, detail: r.detail.slice(0, 500), skillMdPath: p }
  }
  return { ok: false, detail: `ثبّتت ${slug}؟ — ما لقيناش SKILL.md بعد التثبيت` }
}

/** Find the SKILL.md a harness installed (site-packages, ~/.cli-anything, cwd). */
export function locateSkillMd(slug: string): string | null {
  const appSlug = slug.replace(/^cli-anything-/, '')
  const candidates: string[] = []
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) candidates.push(path.join(home, '.cli-anything', appSlug, 'SKILL.md'))
  if (home) candidates.push(path.join(home, '.cli-anything', slug, 'SKILL.md'))
  // site-packages scan (best effort, bounded)
  for (const base of [path.join(home, '.local', 'lib'), '/usr/local/lib', '/usr/lib']) {
    if (!existsSync(base)) continue
    for (const versionDir of safeReaddir(base)) {
      if (!/python3\./.test(versionDir)) continue
      const sp = path.join(base, versionDir, 'site-packages')
      if (!existsSync(sp)) continue
      for (const entry of safeReaddir(sp)) {
        if (!entry.toLowerCase().includes(appSlug) && !entry.toLowerCase().includes(slug.toLowerCase())) continue
        const p = path.join(sp, entry, 'SKILL.md')
        if (existsSync(p)) candidates.push(p)
      }
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Parse a CLI-Anything SKILL.md into its executable surface.
 * Lenient on format (SKILL.md is markdown): extracts every
 * `cli-anything-<app> <command> …` invocation it mentions.
 */
export function parseSkillMd(raw: string, appHint?: string): SkillMd {
  const app =
    appHint ||
    (raw.match(/cli-anything-([a-z0-9-]+)/i)?.[1]) ||
    (raw.match(/^name:\s*([a-z0-9-]+)/im)?.[1]) ||
    'app'
  const commands: SkillCommand[] = []
  const seen = new Set<string>()
  const re = /cli-anything-([a-z0-9-]+)[ \t]+([\w-]+)(?:[ \t]+([\w-]+))?(?:[ \t]*--json)?[ \t]*(?:`|\"|')?(?:\s|$|[`"'])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const prefix = `cli-anything-${m[1]}`
    const cmd = m[2]
    const sub = m[3] || ''
    const full = sub ? `${prefix} ${cmd} ${sub}` : `${prefix} ${cmd}`
    if (!seen.has(full)) {
      seen.add(full)
      commands.push({ command: full, example: m[0].trim() })
    }
  }
  // fallback: any fenced code block lines starting with the prefix
  if (commands.length === 0) {
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (/^cli-anything-[a-z0-9-]+\s+/.test(t) && !seen.has(t)) {
        seen.add(t)
        commands.push({ command: t })
      }
    }
  }
  return { name: `cli-anything-${app}`, app, commands, raw: raw.slice(0, 20000) }
}

/**
 * Register a harness (learned surface) in the DB. Idempotent per (business, app).
 */
export async function registerHarness(input: {
  businessId: string
  userId: string
  app: string
  display: string
  source: 'prebuilt' | 'generated' | 'native'
  skill: SkillMd
  command?: string
}): Promise<{ ok: boolean; detail: string; app?: string }> {
  const command = input.command || input.skill.name
  const row = await db.appHarness.upsert({
    where: { businessId_app: { businessId: input.businessId, app: input.app } },
    create: {
      businessId: input.businessId,
      userId: input.userId,
      app: input.app,
      display: input.display,
      source: input.source,
      skillMd: JSON.stringify(input.skill.commands),
      command,
      argsTemplate: '--json {args}',
    },
    update: {
      display: input.display,
      source: input.source,
      skillMd: JSON.stringify(input.skill.commands),
      command,
      status: 'active',
      lastUsedAt: new Date(),
    },
  })
  return { ok: true, detail: `اتسجّل harness لـ«${input.display}» (${row.source}) — ${input.skill.commands.length} أمر جاهز`, app: input.app }
}

/** Load the business's registered harnesses (the brain's learned apps). */
export async function learnedHarnesses(businessId: string): Promise<Array<{ app: string; display: string; command: string; argsTemplate: string | null; commands: SkillCommand[]; source: string }>> {
  const rows = await db.appHarness.findMany({ where: { businessId, status: 'active' } })
  return rows.map((r) => {
    let commands: SkillCommand[] = []
    try {
      commands = JSON.parse(r.skillMd)
    } catch {
      commands = []
    }
    return { app: r.app, display: r.display, command: r.command, argsTemplate: r.argsTemplate, commands, source: r.source }
  })
}

/** Prompt block for learned harnesses (injected after the native skills). */
export async function harnessesPromptBlock(businessId: string): Promise<string> {
  const rows = await learnedHarnesses(businessId)
  if (rows.length === 0) return ''
  const lines = rows.map((h) => {
    const cmds = h.commands.slice(0, 10).map((c) => `  • ${c.command}`).join('\n')
    return `- «${h.display}» (${h.app}) — harness حقيقي اتبنى على الجهاز (${h.source}) — cli_control_app(app="${h.app}", command="…", args="…")\n${cmds}`
  })
  return `# الهارنسات المتعلمة (اتبنت على جهازك — CLI-Anything)\nده برامجك أنت اللي وكيل اتبنى ليعمل عليها — مش محاكاة — كل أمر فيه ` + '`--json` حقيقي:\n' + lines.join('\n')
}

/**
 * Execute a command on a registered harness (the real installed CLI, JSON
 * output per the CLI-Anything contract). Fails closed with honest status.
 */
export async function execHarness(
  harness: { command: string; argsTemplate?: string | null },
  app: string,
  command: string,
  args?: string,
): Promise<{ ok: boolean; raw: string; json?: unknown }> {
  const base = harness.command.replace(/\s+--json.*$/, '')
  const parts = base.split(/\s+/)
  const bin = parts[0]
  const rest = parts.slice(1)
  // argsTemplate: "--json {args}" — {args} = "<command> [arg]"
  const tpl = harness.argsTemplate || '--json {args}'
  const jsonArgs = tpl.replace('{args}', command + (args ? ` ${args}` : ''))
  const fullArgs = [...rest, ...jsonArgs.split(/\s+/).filter(Boolean)]
  const r = await runCmd(bin, fullArgs, 60000)
  if (!r.ok) {
    return { ok: false, raw: `الفشل في تشغيل ${bin}: ${r.detail}` }
  }
  let json: unknown
  try {
    json = JSON.parse(r.detail)
    return { ok: true, raw: r.detail, json }
  } catch {
    // not JSON — return text (still a real execution)
    return { ok: true, raw: r.detail }
  }
}

/** Stream-safe file read (bounded) for SKILL.md on huge files. */
export async function readFileBounded(file: string, max = 200000): Promise<string> {
  return new Promise((resolve) => {
    const st = statSync(file)
    const rl = createInterface({ input: createReadStream(file) })
    let out = ''
    let n = 0
    rl.on('line', (line) => {
      n++
      if (out.length + line.length < max && n < 4000) out += line + '\n'
      else rl.close()
    })
    rl.on('close', () => resolve(out || readFileSync(file, 'utf-8').slice(0, max)))
    void st
  })
}

/**
 * The 7-phase generation pipeline (real CLI-Anything, for apps with source).
 * Runs the installed `cli-anything` plugin's pipeline when present; otherwise
 * returns an honest status + exactly what the owner can do.
 */
export async function generatePipeline(app: string, sourcePath: string): Promise<HarnessProbe> {
  if (!sourcePath || !existsSync(sourcePath)) {
    return { ok: false, detail: 'الخطوة P0 فاشلة: مفيش مسار مصدر حقيقي — CLI-Anything بيرفض أسماء programs من غير كود (ده مبدأه: source path أو URL حقيقي).' }
  }
  const plugin = await runCmd(PY, ['-m', 'cli_anything', 'generate', app, '--source', sourcePath], 240000)
  if (plugin.ok) return { ok: true, detail: `P1–P7 اكتملت عبر cli-anything.generate\n${plugin.detail.slice(0, 600)}` }
  const opencode = await runCmd('opencode', ['run', 'cli-anything', app, sourcePath], 240000)
  if (opencode.ok) return { ok: true, detail: `اكتملت عبر opencode cli-anything\n${opencode.detail.slice(0, 600)}` }
  return {
    ok: false,
    detail:
      `P0 (مصدر حقيقي) اتحقق منه ✓ — بس الـ pipeline الكامل (P1–P7: تحليل الكود ← تصميم CLI ← تنفيذ Click + REPL + --json ← tests ← PyPI) ` +
      `مش متثبت على الجهاز دلوقتي. طريقتين:\n` +
      `1) ثبّت الأداة: ${PY} -m pip install -U cli-anything-hub  (وبعدين أعمل generate تاني)\n` +
      `2) ثبّت opencode أو claude code + الـ plugin: cli-anything (github.com/HKUDS/CLI-Anything) وأنا أشغّل الـ 7 phases كاملة من عندي\n` +
      `أول ما يتثبت، هكمل وأسجّل الـ SKILL.md الناتج كهارنس شغّال.`,
  }
}

export { existsSync as _existsSync }
