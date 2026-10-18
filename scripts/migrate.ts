import { isAbsolute } from 'node:path'
import { applyMigrations } from './lib/migrations'
const url = process.env.DATABASE_URL
if (!url?.startsWith('file:') || !isAbsolute(url.slice(5))) throw new Error('Set an explicit absolute DATABASE_URL=file:/path/to/database; snapshot and stop writers first')
await applyMigrations(url.slice(5))
console.log('PASS: versioned SQLite migrations applied; no demo users/accounts auto-claimed')
