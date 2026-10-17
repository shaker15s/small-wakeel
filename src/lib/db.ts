import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'

// Resolve the actual local database file path:
const localDbPath = path.resolve(process.cwd(), 'db/custom.db')
const currentUrl = process.env.DATABASE_URL || ''
const currentFilePath = currentUrl.startsWith('file:') ? currentUrl.replace(/^file:/, '') : ''

if (!currentUrl || (currentFilePath && !fs.existsSync(currentFilePath)) || currentUrl.includes('/home/z/')) {
  process.env.DATABASE_URL = `file:${localDbPath}`
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaUrl: string | undefined
}

// If global instance exists but was created with an invalid URL, clear it
if (globalForPrisma.prisma && globalForPrisma.prismaUrl !== process.env.DATABASE_URL) {
  globalForPrisma.prisma = undefined
}

let dbInstance: PrismaClient

try {
  dbInstance =
    globalForPrisma.prisma ??
    new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
      log: ['error', 'warn'],
    })
  globalForPrisma.prismaUrl = process.env.DATABASE_URL
} catch (err) {
  console.warn('[AI Studio] Database not connected — using mock proxy', err)
  const noOp: any = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async (d: any) => d?.data ?? {},
    update: async (d: any) => d?.data ?? {},
    delete: async () => ({}),
    count: async () => 0,
    aggregate: async () => ({}),
    groupBy: async () => [],
    upsert: async (d: any) => d?.create ?? {},
  }
  dbInstance = new Proxy({} as any, {
    get: (_, prop) => {
      if (prop === '$connect' || prop === '$disconnect') return async () => {}
      if (prop === '$transaction') return async (fn: any) => (typeof fn === 'function' ? fn(dbInstance) : Promise.all(fn))
      return noOp
    },
  })
}

export const db = dbInstance

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db