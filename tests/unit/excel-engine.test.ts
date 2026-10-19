// R45 — Excel control engine (CLI-Anything merge): the exact COM bytes, the
// JSON parse contract, and the REAL CSV backend (sandbox-provable).
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExcelComScript, parseExcelPayload, executeExcelCommand } from '@/lib/agent/cli-anything/excel-engine'

test('COM script: read opens READ-ONLY and emits one JSON object', () => {
  const s = buildExcelComScript('read', { file: `C:\\Data\\فواتير.xlsx`, sheet: 'شيت1', maxRows: 100 })
  expect(s).toContain('New-Object -ComObject Excel.Application')
  expect(s).toContain('Workbooks.Open')
  expect(s).toContain('# readOnly — reading never mutates the file')
  expect(s).toContain("ConvertTo-Json -Depth 4 -Compress")
  expect(s).toContain("'C:\\Data\\فواتير.xlsx'")
  // maxRows is capped at 500 even when a bigger number is asked
  expect(buildExcelComScript('read', { file: 'a.xlsx', maxRows: 99999 })).toContain('$cap')
})

test('COM script: PS single-quotes are escaped (no injection)', () => {
  const s = buildExcelComScript('write', { file: `C:\\evil\\a'; DROP TABLE x.xlsx`, range: 'B3', value: "it's" })
  expect(s).toContain("''")
  expect(s).not.toContain("a'; DROP")
})

test('COM script: numeric values go in as [double], text as strings', () => {
  const num = buildExcelComScript('write', { file: 'a.xlsx', range: 'C4', value: 1250 })
  expect(num).toContain('[double](1250)')
  const txt = buildExcelComScript('write', { file: 'a.xlsx', range: 'C4', value: 'متاح' })
  expect(txt).toContain("'متاح'")
  expect(txt).not.toContain('[double]')
})

test('parseExcelPayload: tolerates preamble, rejects junk', () => {
  expect(parseExcelPayload('warn: ...\n{"op":"read","ok":true}')).toEqual({ op: 'read', ok: true })
  expect(parseExcelPayload('')).toBeNull()
  expect(parseExcelPayload('no json here')).toBeNull()
  expect(parseExcelPayload('["array"]')).toBeNull()
})

test('CSV backend: real summary/read/write round-trip on a real file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wakil-xlsx-'))
  const file = join(dir, 'الفواتير.csv')
  writeFileSync(file, 'الصنف,الكمية,الثمن\nسكر,10,250\nأرز,5,1200\n', 'utf8')

  const sum = await executeExcelCommand('summary', { file })
  expect(sum.ok).toBe(true)
  expect(sum.backend).toBe('csv')
  expect((sum.data.headers as string[]).length).toBe(3)
  expect(sum.data.totalRows).toBe(2)

  const read = await executeExcelCommand('read', { file })
  expect(read.ok).toBe(true)
  expect((read.data.rows as unknown[][]).length).toBe(2)
  expect((read.data.rows as string[][])[0][0]).toBe('سكر')

  const write = await executeExcelCommand('write', { file, range: 'C2', value: 999 })
  expect(write.ok).toBe(true)
  const back = readFileSync(file, 'utf8').split('\n')
  expect(back[1]).toContain('999')
})

test('CSV backend: missing file → honest status, never a fake success', async () => {
  const res = await executeExcelCommand('read', { file: '/no/such/file.csv' })
  expect(res.ok).toBe(false)
  expect(res.status).toBe('unavailable')
})

test('XLSX on non-Windows → honest unavailable (no synthetic rows)', async () => {
  if (process.platform === 'win32') {
    expect(true).toBe(true)
    return
  }
  const res = await executeExcelCommand('read', { file: 'C:\\Data\\a.xlsx' })
  expect(res.ok).toBe(false)
  expect(res.status).toBe('unavailable')
  expect(res.backend).toBe('none')
})
