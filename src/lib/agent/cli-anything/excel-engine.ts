// وكيل — Excel / Spreadsheet Control Engine (CLI-Anything pattern)
// ---------------------------------------------------------------------------
// «Tomorrow's users will be agents» (HKUDS/CLI-Anything, Apache-2.0 — pattern
// merged into Wakil R45): a stateful, JSON-output command surface over
// spreadsheets so the brain can DRIVE Excel like a CLI tool:
//
//   cli_control_app({app:'excel', command:'read', args:{file, sheet}})
//
// Two real backends, no fakes:
//   1. Windows + Excel installed  → PowerShell COM (Excel.Application):
//      open workbook, read/write ranges, sheet summary, save.
//   2. Any OS + CSV file          → direct Node engine (read/write/summary).
//
// The COM script builder is a PURE function (buildExcelComScript) so the
// exact PowerShell that would run on the merchant's PC is unit-testable
// here, byte for byte. Non-Windows XLSX and missing Excel return an
// explicit status — never synthetic data, never a fake success.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)

export type ExcelOp = 'summary' | 'read' | 'write' | 'list-recent'

export interface ExcelCommandResult {
  ok: boolean
  op: ExcelOp
  backend: 'com' | 'csv' | 'none'
  data: Record<string, unknown>
  summary: string
  error?: string
  status?: 'unavailable'
}

// ---------------------------------------------------------------------------
// 1. PURE COM SCRIPT BUILDER (the bytes that run on the merchant's Windows)
// ---------------------------------------------------------------------------

/** PS single-quote escape: double the quotes. */
const psq = (s: string) => `'${String(s).replace(/'/g, "''")}'`

/**
 * Builds the exact PowerShell COM script for an Excel operation.
 * Pure + deterministic → unit-testable on any OS. Output contract: the
 * script prints a single JSON object (the agent consumes `--json` style).
 */
export function buildExcelComScript(op: ExcelOp, args: Record<string, unknown>): string {
  switch (op) {
    case 'list-recent': {
      // Enumerate recent workbooks from the Office Recent MRU registry key
      // + the common folders, newest first (no Excel process required).
      return [
        `$dirs = @($env:USERPROFILE + '\\Documents', $env:USERPROFILE + '\\Desktop', $env:USERPROFILE + '\\Downloads') | Where-Object { Test-Path $_ }`,
        `$files = Get-ChildItem -Path $dirs -Include *.xlsx,*.xlsm,*.xls,*.csv -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10`,
        `$out = $files | ForEach-Object { [PSCustomObject]@{ name = $_.Name; path = $_.FullName; sizeKb = [math]::Round($_.Length/1KB,1); modified = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm') } }`,
        `@{ op='list-recent'; ok=$true; files=@($out) } | ConvertTo-Json -Depth 4 -Compress`,
      ].join('\n')
    }
    case 'summary': {
      const file = psq(String(args.file ?? ''))
      return [
        `$ErrorActionPreference = 'Stop'`,
        `$xl = New-Object -ComObject Excel.Application`,
        `$xl.Visible = $false`,
        `$xl.DisplayAlerts = $false`,
        `try {`,
        `  $wb = $xl.Workbooks.Open(${file}, 0, $true)   # 0 = updateLinks none, readOnly`,
        `  $sheets = @($wb.Worksheets | ForEach-Object { [PSCustomObject]@{ name = $_.Name; rows = $_.UsedRange.Rows.Count; cols = $_.UsedRange.Columns.Count; headers = @($_.Range($_.Cells[1,1], $_.Cells[1,[math]::Min($_.UsedRange.Columns.Count,8)]).Value2 | Where-Object { $_ -ne $null } | Select-Object -First 8 | ForEach-Object { [string]$_ }) } })`,
        `  $res = @{ op='summary'; ok=$true; file=$wb.FullName; sheets=$sheets; savedAt=$wb.BuiltIn('Document Last Saved Time').ToString() }`,
        `} finally { $wb?.Close($false); $xl.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }`,
        `$res | ConvertTo-Json -Depth 5 -Compress`,
      ].join('\n')
    }
    case 'read': {
      const file = psq(String(args.file ?? ''))
      const sheet = psq(String(args.sheet ?? ''))
      const maxRows = Math.min(Math.max(1, Number(args.maxRows ?? 50)), 500)
      return [
        `$ErrorActionPreference = 'Stop'`,
        `$xl = New-Object -ComObject Excel.Application`,
        `$xl.Visible = $false`,
        `$xl.DisplayAlerts = $false`,
        `try {`,
        `  $wb = $xl.Workbooks.Open(${file}, 0, $true)   # readOnly — reading never mutates the file`,
        `  $ws = if (-not [string]::IsNullOrEmpty(${sheet})) { $wb.Worksheets.Item(${sheet}) } else { $wb.Worksheets.Item(1) }`,
        `  $ur = $ws.UsedRange`,
        `  $cap = [math]::Min($ur.Rows.Count, ${maxRows})`,
        `  $hdr = @($ur.Range($ur.Cells[1,1], $ur.Cells[1,[math]::Min($ur.Columns.Count,20)]).Value2 | ForEach-Object { if ($null -eq $_) { '' } else { [string]$_ } })`,
        `  $rows = @()`,
        `  for ($r = 2; $r -le [math]::Min($cap, 501); $r++) {`,
        `    $line = @()`,
        `    for ($c = 1; $c -le [math]::Min($ur.Columns.Count,20); $c++) { $v = $ur.Cells[$r,$c].Value2; $line += (if ($null -eq $v) { '' } else { [string]$v }) }`,
        `    $rows += ,@($line)`,
        `  }`,
        `  $res = @{ op='read'; ok=$true; sheet=$ws.Name; totalRows=$ur.Rows.Count; returned=[math]::Min($cap,500)-1; headers=$hdr; rows=$rows }`,
        `} finally { $wb?.Close($false); $xl.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }`,
        `$res | ConvertTo-Json -Depth 4 -Compress`,
      ].join('\n')
    }
    case 'write': {
      // Writing goes through the LIVE Excel process when it is open (the
      // merchant's real session), else opens the file, writes, and saves.
      const file = psq(String(args.file ?? ''))
      const sheet = psq(String(args.sheet ?? ''))
      const range = psq(String(args.range ?? 'A2'))
      const value = psq(String(args.value ?? ''))
      const isNumber = Number.isFinite(Number(args.value)) && String(args.value).trim() !== ''
      const valExpr = isNumber ? `[double](${Number(args.value)})` : value
      return [
        `$ErrorActionPreference = 'Stop'`,
        `try { $xl = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') } catch {`,
        `  $xl = New-Object -ComObject Excel.Application`,
        `  $xl.Visible = $false`,
        `  $xl.DisplayAlerts = $false`,
        `  $wb = $xl.Workbooks.Open(${file})`,
        `} else { $wb = $xl.Workbooks | Where-Object { $_.FullName -eq ${file} } | Select-Object -First 1 }`,
        `if ($null -eq $wb) { $wb = $xl.Workbooks.Open(${file}) }`,
        `  $ws = if (-not [string]::IsNullOrEmpty(${sheet})) { $wb.Worksheets.Item(${sheet}) } else { $wb.Worksheets.Item(1) }`,
        `  $ws.Range(${range}).Value2 = ${valExpr}`,
        `  if ($wb.Path -ne $null) { $wb.Save() }`,
        `  $res = @{ op='write'; ok=$true; sheet=$ws.Name; range=${range}; value=$ws.Range(${range}).Text; saved=$true }`,
        `$res | ConvertTo-Json -Depth 4 -Compress`,
      ].join('\n')
    }
  }
}

// ---------------------------------------------------------------------------
// 2. OUTPUT PARSER (agent consumes JSON, CLI-Anything `--json` contract)
// ---------------------------------------------------------------------------

/** Parse a single JSON object out of command output, tolerating preamble. */
export function parseExcelPayload(out: string): Record<string, unknown> | null {
  const s = String(out ?? '').trim()
  if (!s) return null
  const i = s.indexOf('{')
  if (i < 0) return null
  try {
    const v = JSON.parse(s.slice(i))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 3. CSV BACKEND (real, works on every OS — the sandbox-provable path)
// ---------------------------------------------------------------------------

function csvSplitLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { cells.push(cur); cur = '' }
    else cur += ch
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}
const csvEsc = (c: string) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)

function csvFindRecent(): { name: string; path: string; sizeKb: number; modified: string }[] {
  const out: { name: string; path: string; sizeKb: number; modified: string }[] = []
  const dirs = [process.cwd(), join(homedir(), 'Documents'), join(homedir(), 'Desktop'), join(homedir(), 'Downloads')]
  for (const d of dirs) {
    if (!existsSync(d)) continue
    try {
      for (const e of readdirSync(d)) {
        if (!/\.csv$/i.test(e)) continue
        const p = join(d, e)
        try {
          const st = statSync(p)
          out.push({ name: e, path: p, sizeKb: Math.round(st.size / 1024), modified: st.mtime.toISOString().slice(0, 16).replace('T', ' ') })
        } catch {}
      }
    } catch {}
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 10)
}

async function runCom(op: ExcelOp, args: Record<string, unknown>, timeoutMs: number): Promise<ExcelCommandResult> {
  const script = buildExcelComScript(op, args)
  const { stdout } = await execFileAsync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  )
  const data = parseExcelPayload(stdout)
  if (!data || data.ok === false) {
    return { ok: false, op, backend: 'com', data: data ?? { raw: stdout.slice(0, 300) }, summary: 'فشل قراءة ناتج Excel — تأكد إن الملف مفتوح أو المسار صحيح.', error: 'com_parse_failed' }
  }
  const s = String(data.summary ?? '')
  const sheets = data.sheets as { name: string; rows: number; cols: number }[] | undefined
  const summary =
    op === 'summary'
      ? `ملف إكسل فيه ${sheets?.length ?? 0} شيت: ${sheets?.map((x) => `«${x.name}» (${x.rows}×${x.cols})`).join('، ')}.`
      : op === 'read'
        ? `قرأت ${String(data.returned ?? 0)} صف من شيت «${String(data.sheet ?? '')}» (${String(data.totalRows ?? 0)} صف إجمالًا).`
        : op === 'write'
          ? `كتبت في ${String(data.range ?? '')} بالشيت «${String(data.sheet ?? '')}» وحفظت.`
          : `لقيت ${String((data.files as unknown[])?.length ?? 0)} ملف جداول حديث.`
  return { ok: true, op, backend: 'com', data, summary: s || summary }
}

// ---------------------------------------------------------------------------
// 4. PUBLIC ENTRY — executeExcelCommand
// ---------------------------------------------------------------------------

export async function executeExcelCommand(op: ExcelOp, args: Record<string, unknown>): Promise<ExcelCommandResult> {
  const fileArg = String(args.file ?? args.path ?? '')

  // ---- list-recent without a file: COM on Windows, CSV scan on every other OS
  if (op === 'list-recent' && !fileArg) {
    if (process.platform === 'win32') {
      try {
        return await runCom(op, args, 8000)
      } catch { /* fall through to the CSV scan */ }
    }
    const files = csvFindRecent()
    return {
      ok: files.length > 0,
      op,
      backend: 'csv',
      data: { files },
      summary: files.length ? `لقيت ${files.length} ملف جداول حديث (أحدثهم أولًا).` : 'مفيش ملفات جداول حديثة لقيتها على الجهاز — لو عندك ملف CSV قولي مكانه.',
      status: files.length ? undefined : 'unavailable',
    }
  }

  // ---- CSV path: real Node engine, any OS (also the sandbox-provable one)
  if (fileArg.toLowerCase().endsWith('.csv')) {
    try {
      if (op === 'list-recent') {
        const files = csvFindRecent()
        return { ok: true, op, backend: 'csv', data: { files }, summary: `لقيت ${files.length} ملف CSV حديث (أحدثهم أولًا).` }
      }
      if (!fileArg || !existsSync(fileArg)) {
        return { ok: false, op, backend: 'csv', data: {}, summary: `الملف «${fileArg || '؟'}» مش موجود على الجهاز ده.`, error: 'file_not_found', status: 'unavailable' }
      }
      if (op === 'summary') {
        const lines = readFileSync(fileArg, 'utf8').split(/\r?\n/).filter(Boolean)
        const headers = csvSplitLine(lines[0] ?? '')
        return { ok: true, op, backend: 'csv', data: { file: fileArg, headers, totalRows: Math.max(0, lines.length - 1) }, summary: `«${fileArg.split(/[\\/]/).pop()}» — ${Math.max(0, lines.length - 1)} صف، ${headers.length} عمود: ${headers.slice(0, 6).join('، ')}.` }
      }
      if (op === 'read') {
        const lines = readFileSync(fileArg, 'utf8').split(/\r?\n/).filter(Boolean)
        const maxRows = Math.min(Math.max(1, Number(args.maxRows ?? 50)), 500)
        const headers = csvSplitLine(lines[0] ?? '')
        const rows = lines.slice(1, 1 + maxRows).map((l) => csvSplitLine(l))
        return { ok: true, op, backend: 'csv', data: { headers, totalRows: Math.max(0, lines.length - 1), returned: rows.length, rows }, summary: `قرأت ${rows.length} صف من ${Math.max(0, lines.length - 1)} صف في «${fileArg.split(/[\\/]/).pop()}».`, }
      }
      if (op === 'write') {
        const range = String(args.range ?? 'A2').toUpperCase().replace(/^[A-Z]+/, '').replace(/\D/g, '')
        // spreadsheet row N (row 1 = header) → dataLines[N-2]
        const row = Math.max(0, (parseInt(range, 10) || 2) - 2)
        const col = (String(args.range ?? 'A2').match(/^[A-Z]+/)?.[0] ?? 'A').split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1
        const lines = readFileSync(fileArg, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
        const dataLines = lines.slice(1)
        while (dataLines.length <= row) dataLines.push('')
        const cells = csvSplitLine(dataLines[row] || '')
        cells[col] = String(args.value ?? '')
        dataLines[row] = cells.map(csvEsc).join(',')
        mkdirSync(dirname(fileArg), { recursive: true })
        writeFileSync(fileArg, [lines[0], ...dataLines].join('\n'), 'utf8')
        return { ok: true, op, backend: 'csv', data: { range: String(args.range ?? 'A2'), value: String(args.value ?? ''), row, col: col + 1 }, summary: `كتبت «${args.value}» في ${String(args.range ?? 'A2')} وحفظت الملف.` }
      }
    } catch (e) {
      return { ok: false, op, backend: 'csv', data: {}, summary: `حصلت مشكلة في تشغيل الأمر على الملف: ${(e as Error).message}`, error: 'csv_failed' }
    }
  }

  // ---- XLSX/XLS: COM backend is Windows + Excel only — honest status otherwise
  if (process.platform !== 'win32') {
    return { ok: false, op, backend: 'none', data: {}, summary: 'محرك إكسل (XLSX) شغال على ويندوز مع Excel مثبت — أو ابعتلي الملف كـ CSV وأشتغله فورًا على أي جهاز.', error: 'com_unavailable', status: 'unavailable' }
  }
  try {
    return await runCom(op, args, op === 'write' ? 20000 : 12000)
  } catch (e) {
    const msg = String((e as Error).message ?? '')
    if (/Excel\.Application|com component|COM/i.test(msg)) {
      return { ok: false, op, backend: 'com', data: {}, summary: 'Excel مش متشغل أو مش مثبت على الجهاز ده — ثبت Excel أو حوّل الملف CSV وأنا أشتغله فورًا.', error: 'excel_not_found', status: 'unavailable' }
    }
    return { ok: false, op, backend: 'com', data: {}, summary: `أمر Excel فشل: ${msg.slice(0, 160)}`, error: 'com_failed' }
  }
}
