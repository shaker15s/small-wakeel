// Consistent full local SQLite snapshot. This file is plaintext customer data:
// use a private backup directory and encrypted off-host storage, with keys kept
// separately. Never substitute a live main-file copy when WAL may be active.
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
const url = process.env.DATABASE_URL
if (!url?.startsWith('file:') || !isAbsolute(url.slice(5))) throw new Error('Set an explicit absolute local file: DATABASE_URL')
const index = process.argv.indexOf('--output')
if (index < 0 || !process.argv[index + 1]) throw new Error('Provide --output <new-backup-file>')
const output = resolve(process.argv[index + 1]), directory = dirname(output)
mkdirSync(directory, { recursive: true, mode: 0o700 })
if ((statSync(directory).mode & 0o077) !== 0) throw new Error('Use a private backup directory (mode 0700)')
// SQLite VACUUM INTO accepts an existing EMPTY file. Exclusive create prevents
// overwrite/symlink replacement, and mode 0600 protects it before the first byte.
const sql = new Database(url.slice(5), { readonly: true })
let created = false
try {
  closeSync(openSync(output, 'wx', 0o600)); created = true
  sql.query('VACUUM INTO ?').run(output)
  console.log('Full SQLite snapshot created (0600). Encrypt/store off-host; preserve key versions separately and rehearse restore + auth quarantine before traffic.')
} catch (e) { if (created) rmSync(output, { force: true }); throw e }
finally { sql.close() }
