// وكيل — CLI-Anything Autonomous Application Bridge & Harness Engine
// (محرك الربط الذكي لتطبيقات الكمبيوتر وأنظمة التشغيل عبر CLI-Anything)
//
// Host discovery is diagnostic only. It does NOT connect a merchant's desktop.
// External execution stays fail-closed until a real, tested adapter is installed.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentPluginDTO, ResultCardDTO } from '@/lib/types'

const execFileAsync = promisify(execFile)

export interface ProcessInfo {
  pid: number
  name: string
  title: string
  path?: string
  workingDirectory?: string
  memoryBytes?: number
  memoryFormatted?: string
}

export interface SpreadsheetFileInfo {
  name: string
  path: string
  sizeKb: number
  modifiedAt: string
  previewHeaders?: string[]
  rowCount?: number
}

export interface ExcelInspectionResult {
  isRunning: boolean
  process?: ProcessInfo
  openWorkbooks: string[]
  recentSpreadsheets: SpreadsheetFileInfo[]
}

export interface DatabaseInspectionResult {
  isRunning: boolean
  ports: { port: number; pid: number; service?: string }[]
  localDatabases: { name: string; path: string; sizeKb: number }[]
}

export interface DetectedApp {
  id: string
  name: string
  title: string
  processName: string
  category: 'accounting' | 'pos' | 'spreadsheet' | 'database' | 'browser' | 'productivity' | 'general'
  hasCliHarness: boolean
  cliAnythingModule?: string
  pid?: number
  path?: string
  memoryUsage?: string
}

export interface CliBridgeResult {
  ok: boolean
  appName: string
  slug: string
  statusSteps: { step: string; label: string; state: 'done' | 'active' | 'pending' | 'failed'; ms: number }[]
  capabilities: string[]
  harnessSchema: Record<string, unknown>
  plugin?: AgentPluginDTO
  error?: string
  status?: 'not_connected'
}

export interface BridgedToolParams {
  businessId?: string
  appName: string
  command?: string
  args?: Record<string, unknown>
  processName?: string
}

export interface BridgedToolExecutionResult {
  ok: boolean
  appName: string
  command: string
  durationMs: number
  executedAt: string
  processTelemetry?: ProcessInfo
  data: Record<string, unknown>
  cards: ResultCardDTO[]
  summary: string
  error?: string
  status?: 'not_connected'
}

// ---------------------------------------------------------------------------
// 1. Safe Child Process Helper
// ---------------------------------------------------------------------------

async function runCommandSafe(file: string, args: string[], timeoutMs = 3000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: timeoutMs, windowsHide: true })
    return stdout
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 2. Real System Process Query Engine (Fast Execution + TTL Cache)
// ---------------------------------------------------------------------------

let cachedProcesses: ProcessInfo[] | null = null
let lastProcessScanTime = 0
const PROCESS_CACHE_TTL_MS = 6000

/**
 * Retrieves running system processes with PID, memory usage, and executable paths.
 * Uses a 6s TTL cache to ensure real-time accuracy without repeating expensive OS queries.
 */
export async function getRunningProcesses(forceRefresh = false): Promise<ProcessInfo[]> {
  if (process.env.NODE_ENV === 'production') return []
  const now = Date.now()
  if (!forceRefresh && cachedProcesses && now - lastProcessScanTime < PROCESS_CACHE_TTL_MS) {
    return cachedProcesses
  }

  const procs: ProcessInfo[] = []
  const seenPids = new Set<number>()

  if (process.platform === 'win32') {
    // 1. Fast, universally available Windows tasklist inspection with Window Titles (~200ms)
    try {
      const stdout = await runCommandSafe('tasklist', ['/FO', 'CSV', '/NH'], 2000)
      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const tokens: string[] = []
        let match
        const re = /"([^"]*)"/g
        while ((match = re.exec(line)) !== null) {
          tokens.push(match[1])
        }
        if (tokens.length >= 5) {
          const rawName = tokens[0].replace(/\.exe$/i, '').toLowerCase()
          const pid = parseInt(tokens[1], 10)
          if (!pid || seenPids.has(pid)) continue
          seenPids.add(pid)
          const memKb = parseInt(tokens[4].replace(/[^0-9]/g, ''), 10) || 0
          const rawTitle = tokens.length >= 9 ? tokens[8].trim() : ''
          const cleanTitle = rawTitle !== 'N/A' && rawTitle !== 'OleMainThreadWndName' ? rawTitle : ''
          procs.push({
            pid,
            name: rawName,
            title: cleanTitle,
            memoryBytes: memKb * 1024,
            memoryFormatted: memKb > 0 ? `${(memKb / 1024).toFixed(1)} MB` : undefined,
          })
        }
      }
    } catch {}

    // 2. If tasklist was empty, fallback to pwsh
    if (procs.length === 0) {
      try {
        const psScript = `Get-Process | Where-Object { $_.Path -or $_.MainWindowTitle } | Select-Object -Property Id, ProcessName, MainWindowTitle, Path, WorkingSet64 -First 50 | ConvertTo-Json -Compress`
        const out = await runCommandSafe('pwsh', ['-NoProfile', '-NonInteractive', '-Command', psScript], 2000)
        if (out.trim()) {
          const parsed = JSON.parse(out)
          const rows = Array.isArray(parsed) ? parsed : [parsed]
          for (const r of rows) {
            const pid = Number(r.Id)
            if (!pid || seenPids.has(pid)) continue
            seenPids.add(pid)
            const mem = Number(r.WorkingSet64) || 0
            procs.push({
              pid,
              name: String(r.ProcessName || '').toLowerCase(),
              title: String(r.MainWindowTitle || '').trim(),
              path: r.Path ? String(r.Path) : undefined,
              memoryBytes: mem,
              memoryFormatted: mem > 0 ? `${(mem / 1024 / 1024).toFixed(1)} MB` : undefined,
            })
          }
        }
      } catch {}
    }
  } else {
    // POSIX fallback (Linux / macOS)
    try {
      const stdout = await runCommandSafe('ps', ['-eo', 'pid,rss,comm'], 1500)
      const lines = stdout.split('\n').slice(1)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10)
          const rssKb = parseInt(parts[1], 10) || 0
          const name = parts.slice(2).join(' ').toLowerCase()
          if (!pid || seenPids.has(pid)) continue
          seenPids.add(pid)
          procs.push({
            pid,
            name,
            title: '',
            memoryBytes: rssKb * 1024,
            memoryFormatted: rssKb > 0 ? `${(rssKb / 1024).toFixed(1)} MB` : undefined,
          })
        }
      }
    } catch {}
  }

  cachedProcesses = procs
  lastProcessScanTime = now
  return procs
}

// ---------------------------------------------------------------------------
// 3. Real Excel & Spreadsheet Inspection Engine
// ---------------------------------------------------------------------------

/**
 * Inspects live Excel processes, COM objects, open workbooks, and scans recent spreadsheets.
 */
export async function inspectExcelWorkbooks(): Promise<ExcelInspectionResult> {
  if (process.env.NODE_ENV === 'production') return { isRunning: false, openWorkbooks: [], recentSpreadsheets: [] }
  const procs = await getRunningProcesses()
  const excelProc = procs.find(
    (p) => p.name.includes('excel') || p.name.includes('soffice') || p.name.includes('calc')
  )

  const openWorkbooks: string[] = []

  // Check window title if Excel is running with an open document
  if (excelProc?.title) {
    openWorkbooks.push(excelProc.title)
  }

  // Attempt PowerShell COM inspection if on Windows
  if (process.platform === 'win32' && excelProc) {
    try {
      const comScript = `$xl = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application'); @($xl.Workbooks) | ForEach-Object { $_.FullName } | ConvertTo-Json -Compress`
      const out = await runCommandSafe('pwsh', ['-NoProfile', '-NonInteractive', '-Command', comScript], 2000)
      if (out.trim()) {
        const parsed = JSON.parse(out)
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        for (const wb of arr) {
          if (typeof wb === 'string' && wb.trim() && !openWorkbooks.includes(wb)) {
            openWorkbooks.push(wb.trim())
          }
        }
      }
    } catch {}
  }

  // Real filesystem scanner for recent spreadsheet files
  const recentSpreadsheets: SpreadsheetFileInfo[] = []
  const candidateDirs = [
    process.cwd(),
    join(homedir(), 'Downloads'),
    join(homedir(), 'Documents'),
    join(homedir(), 'Desktop'),
    join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Office', 'Recent'),
  ]

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (recentSpreadsheets.length >= 10) break
        const lower = entry.toLowerCase()
        const isSheet =
          lower.endsWith('.xlsx') ||
          lower.endsWith('.xls') ||
          lower.endsWith('.csv') ||
          (dir.includes('Recent') && lower.endsWith('.lnk'))

        if (isSheet) {
          const fullPath = join(dir, entry)
          try {
            const st = statSync(fullPath)
            const sizeKb = Math.round(st.size / 1024)
            const item: SpreadsheetFileInfo = {
              name: entry,
              path: fullPath,
              sizeKb,
              modifiedAt: st.mtime.toISOString(),
            }

            // For CSV spreadsheets, parse actual header columns and count rows
            if (lower.endsWith('.csv')) {
              try {
                const content = readFileSync(fullPath, 'utf8')
                const lines = content.split(/\r?\n/).filter(Boolean)
                if (lines.length > 0) {
                  item.previewHeaders = lines[0].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''))
                  item.rowCount = lines.length - 1
                }
              } catch {}
            }

            recentSpreadsheets.push(item)
          } catch {}
        }
      }
    } catch {}
  }

  return {
    isRunning: Boolean(excelProc),
    process: excelProc,
    openWorkbooks,
    recentSpreadsheets,
  }
}

// ---------------------------------------------------------------------------
// 4. Real Database & Listening Service Inspection Engine
// ---------------------------------------------------------------------------

/**
 * Queries active listening network ports, running database daemons, and local database files.
 */
export async function inspectDatabaseOrService(): Promise<DatabaseInspectionResult> {
  if (process.env.NODE_ENV === 'production') return { isRunning: false, ports: [], localDatabases: [] }
  const ports: { port: number; pid: number; service?: string }[] = []
  const localDatabases: { name: string; path: string; sizeKb: number }[] = []

  const knownPorts: Record<number, string> = {
    5432: 'PostgreSQL',
    3306: 'MySQL / MariaDB',
    6379: 'Redis Cache',
    27017: 'MongoDB',
    1433: 'MS SQL Server',
    3000: 'Wakil Web Core',
    8080: 'POS / ERP Web Portal',
    5000: 'Flask / Python Service',
    8000: 'FastAPI / Django',
  }

  // Query listening sockets via netstat
  try {
    const stdout = await runCommandSafe('netstat', ['-ano'], 2000)
    const lines = stdout.split(/\r?\n/)
    for (const line of lines) {
      if (!line.includes('LISTENING')) continue
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 4) {
        const addr = parts[1]
        const portStr = addr.split(':').pop()
        const pidStr = parts[parts.length - 1]
        const port = parseInt(portStr || '', 10)
        const pid = parseInt(pidStr, 10)
        if (port && !ports.some((p) => p.port === port)) {
          ports.push({
            port,
            pid: isNaN(pid) ? 0 : pid,
            service: knownPorts[port] || 'TCP Service',
          })
        }
      }
    }
  } catch {}

  // Scan local SQLite / application database files in workspace
  const dbCandidates = [
    join(process.cwd(), 'db', 'custom.db'),
    join(process.cwd(), 'prisma', 'dev.db'),
    join(process.cwd(), 'custom.db'),
    join(process.cwd(), 'db.sqlite'),
  ]

  for (const cand of dbCandidates) {
    if (existsSync(cand)) {
      try {
        const st = statSync(cand)
        localDatabases.push({
          name: cand.split(/[\/\\]/).pop() || 'database.db',
          path: cand,
          sizeKb: Math.round(st.size / 1024),
        })
      } catch {}
    }
  }

  return {
    isRunning: ports.length > 0 || localDatabases.length > 0,
    ports: ports.slice(0, 10),
    localDatabases,
  }
}

// ---------------------------------------------------------------------------
// 5. Running Application Scanner (Frontend / Onboarding Interface)
// ---------------------------------------------------------------------------

/**
 * Scans local machine for running business and desktop applications with live telemetry.
 */
export async function scanRunningApplications(): Promise<DetectedApp[]> {
  if (process.env.NODE_ENV === 'production') return []
  const apps: DetectedApp[] = []
  const seen = new Set<string>()

  const procs = await getRunningProcesses()

  // Ignore internal Windows/OS services that are not business applications
  const ignorePatterns = [
    'svchost', 'conhost', 'aggregatorhost', 'dllhost', 'runtimebroker', 'audiodg',
    'searchindexer', 'searchprotocolhost', 'applicationframehost', 'wmi', 'system',
    'idle', 'tasklist', 'services', 'lsass', 'csrss', 'smss', 'wininit', 'winlogon',
  ]

  for (const p of procs) {
    const name = p.name.toLowerCase()
    if (ignorePatterns.some((ig) => name.includes(ig))) continue
    if (seen.has(name)) continue
    seen.add(name)

    const detected = categorizeProcess(p.name, p.title, String(p.pid), p.path, p.memoryFormatted)
    apps.push(detected)
  }

  // Baseline standard business profiles always available to connect
  const baselineApps: DetectedApp[] = [
    {
      id: 'excel_sheets',
      name: 'جداول إكسل / مايكروسوفت أوفيس (Excel / Calc)',
      title: 'دفاتر الجداول، فواتير المبيعات، وقوائم الأسعار',
      processName: 'excel',
      category: 'spreadsheet',
      hasCliHarness: false,
      cliAnythingModule: 'libreoffice',
    },
    {
      id: 'sqlite_db',
      name: 'قواعد بيانات ونقاط بيع محلية (SQL / Access / POS)',
      title: 'قاعدة بيانات البرنامج المحاسبي المحلي ونقاط البيع',
      processName: 'pos_db',
      category: 'database',
      hasCliHarness: false,
      cliAnythingModule: 'firefly-iii',
    },
    {
      id: 'web_portal',
      name: 'بوابة الويب / متصفح السحابة (Chrome / Edge / Odoo / Daftra)',
      title: 'نظام الحسابات السحابي وفواتير الموردين',
      processName: 'chrome',
      category: 'browser',
      hasCliHarness: false,
      cliAnythingModule: 'browser',
    },
    {
      id: 'custom_erp',
      name: 'برنامج محاسبة أو كاشير مخصص (Desktop POS / ERP)',
      title: 'تطبيق سطح مكتب مخصص للأنشطة والمحلات',
      processName: 'custom_erp',
      category: 'pos',
      hasCliHarness: false,
    },
  ]

  for (const b of baselineApps) {
    if (!apps.some((a) => a.processName === b.processName || a.id === b.id)) {
      apps.push(b)
    }
  }

  return apps
}

function categorizeProcess(
  proc: string,
  title: string,
  id: string,
  path?: string,
  memoryUsage?: string,
): DetectedApp {
  const p = proc.toLowerCase()
  const t = title.toLowerCase()

  if (p.includes('excel') || t.includes('excel') || t.includes('calc') || t.includes('sheet') || p.includes('soffice')) {
    return {
      id,
      name: 'مايكروسوفت إكسل (Excel)',
      title: title || 'دفتر جداول وفواتير إكسل',
      processName: proc,
      category: 'spreadsheet',
      hasCliHarness: false,
      cliAnythingModule: 'libreoffice',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('ameen') || t.includes('ameen') || t.includes('الأمين') || t.includes('الامين')) {
    return {
      id,
      name: 'برنامج الأمين للمحاسبة (Al-Ameen ERP)',
      title: title || 'نظام إدارة الحسابات والمستودعات الأمين',
      processName: proc,
      category: 'accounting',
      hasCliHarness: false,
      cliAnythingModule: 'al-ameen-cli',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('daftra') || t.includes('daftra') || t.includes('دفترة')) {
    return {
      id,
      name: 'دفترة للحسابات (Daftra Desktop / Cloud)',
      title: title || 'نظام الفواتير وإدارة الأعمال دفترة',
      processName: proc,
      category: 'accounting',
      hasCliHarness: false,
      cliAnythingModule: 'daftra-cli',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('easystore') || t.includes('easystore') || t.includes('ايزي ستور') || t.includes('إيزي ستور')) {
    return {
      id,
      name: 'برنامج إيزي ستور (EasyStore POS)',
      title: title || 'نظام الكاشير وإدارة المتاجر إيزي ستور',
      processName: proc,
      category: 'pos',
      hasCliHarness: false,
      cliAnythingModule: 'easystore-cli',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('quickbooks') || p.includes('qbw') || t.includes('quickbooks')) {
    return {
      id,
      name: 'كويك بوكس (QuickBooks Desktop)',
      title: title || 'نظام الحسابات المالية كويك بوكس',
      processName: proc,
      category: 'accounting',
      hasCliHarness: false,
      cliAnythingModule: 'quickbooks-cli',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('tally') || t.includes('tally')) {
    return {
      id,
      name: 'تالي إي آر بي (Tally ERP / Prime)',
      title: title || 'نظام المحاسبة وإدارة المخزون تالي',
      processName: proc,
      category: 'accounting',
      hasCliHarness: false,
      cliAnythingModule: 'tally-cli',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('onyx') || t.includes('أونكس') || t.includes('onyx')) {
    return {
      id,
      name: 'أونكس برو (Onyx Pro ERP)',
      title: title || 'نظام إدارة الشركات والمصانع أونكس برو',
      processName: proc,
      category: 'accounting',
      hasCliHarness: false,
      cliAnythingModule: 'onyx-cli',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('pos') || t.includes('pos') || t.includes('كاشير') || t.includes('فاتورة') || t.includes('مبيعات')) {
    return {
      id,
      name: title || 'برنامج الكاشير والمبيعات (POS)',
      title,
      processName: proc,
      category: 'pos',
      hasCliHarness: false,
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('access') || p.includes('sql') || p.includes('postgres') || p.includes('mysql') || t.includes('database')) {
    return {
      id,
      name: 'قاعدة بيانات محلية (Access / SQL)',
      title,
      processName: proc,
      category: 'database',
      hasCliHarness: false,
      cliAnythingModule: 'firefly-iii',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  if (p.includes('chrome') || p.includes('msedge') || p.includes('firefox') || p.includes('brave')) {
    return {
      id,
      name: `المتصفح: ${title ? title.slice(0, 30) : proc}`,
      title,
      processName: proc,
      category: 'browser',
      hasCliHarness: false,
      cliAnythingModule: 'browser',
      pid: Number(id),
      path,
      memoryUsage,
    }
  }
  return {
    id,
    name: title ? title.slice(0, 35) : proc,
    title,
    processName: proc,
    category: title ? 'accounting' : 'general',
    hasCliHarness: false,
    pid: Number(id),
    path,
    memoryUsage,
  }
}

// ---------------------------------------------------------------------------
// 6. CLI-Anything Module & Registry Inspector
// ---------------------------------------------------------------------------

export function getCliAnythingRegistry(): Record<string, unknown> {
  const regPath = join(process.cwd(), 'cli-anything', 'registry.json')
  if (existsSync(regPath)) {
    try {
      return JSON.parse(readFileSync(regPath, 'utf8'))
    } catch {
      return {}
    }
  }
  return {}
}

// ---------------------------------------------------------------------------
// 7. Live Bridged Tool Execution Engine (Real Queries & Structured JSON)
// ---------------------------------------------------------------------------

export interface DesktopDataFile {
  name: string
  path: string
  sizeKb: number
  type: string
  modifiedAt?: string
}

export interface DesktopInspectionResult {
  appName: string
  isRunning: boolean
  process?: ProcessInfo
  dataFiles: DesktopDataFile[]
  reconciliation: {
    matchedCount: number
    discrepancyCount: number
    items: {
      name: string
      localStock: number
      externalStock: number
      diff: number
      status: string
    }[]
  }
  cards: ResultCardDTO[]
  summary: string
}

/** Local host diagnostics, never external financial data or reconciliation. */
export async function inspectDesktopApplication(
  appName: string,
  businessId?: string,
): Promise<DesktopInspectionResult> {
  const cleanName = appName.trim() || 'تطبيق العمل'
  const procs = await getRunningProcesses()
  const proc = procs.find((p) => p.name.includes(cleanName.toLowerCase()))
  return {
    appName: cleanName,
    isRunning: Boolean(proc),
    process: proc,
    dataFiles: [],
    reconciliation: { matchedCount: 0, discrepancyCount: 0, items: [] },
    cards: notConnectedCards(cleanName),
    summary: NOT_CONNECTED_MESSAGE,
  }
}

const NOT_CONNECTED_MESSAGE = 'غير متصل: لا يوجد موصل خارجي موثّق لهذا التطبيق. لم تُقرأ أو تُكتب بيانات خارجية، ولم تتم مطابقة مخزون أو مزامنة فواتير. فحص السيرفر لا يتيح الوصول لجهاز العميل.'

function notConnectedCards(appName: string): ResultCardDTO[] {
  return [{
    kind: 'kv',
    title: `حالة اتصال «${appName}»`,
    rows: [{ label: 'الاتصال الخارجي', value: NOT_CONNECTED_MESSAGE, tone: 'bad' }],
  }]
}

/** No synthetic data, internal-ledger fallback or success without an adapter. */
export async function executeBridgedTool(params: BridgedToolParams): Promise<BridgedToolExecutionResult> {
  const appName = params.appName.trim() || 'تطبيق العمل'
  return {
    ok: false,
    status: 'not_connected',
    appName,
    command: params.command ?? 'check_status',
    durationMs: 0,
    executedAt: new Date().toISOString(),
    data: { source: 'none', connectionStatus: 'not_connected' },
    cards: notConnectedCards(appName),
    summary: NOT_CONNECTED_MESSAGE,
    error: 'not_connected',
  }
}

/** Fail before registration: a generated command schema is not a connection. */
export async function bridgeApplicationWithCliAnything(params: {
  businessId: string
  userId: string
  appName: string
  processName?: string
  appPath?: string
  businessType?: string
}): Promise<CliBridgeResult> {
  const appName = params.appName.trim() || 'تطبيق العمل'
  return {
    ok: false,
    status: 'not_connected',
    appName,
    slug: '',
    statusSteps: [{ step: 'connect', label: NOT_CONNECTED_MESSAGE, state: 'failed', ms: 0 }],
    capabilities: [],
    harnessSchema: {},
    error: 'not_connected',
  }
}
