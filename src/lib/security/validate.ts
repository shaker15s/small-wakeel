// وكيل — request payload validation (zod).
//
// Zod was already a dependency but unused: handlers hand-cast `await req.json()`
// to a TypeScript interface, which validates NOTHING at runtime. Every mutating
// route now parses through a schema, so a missing field, a wrong type or a
// 10MB string is rejected with a clear Arabic message instead of reaching the
// domain layer (or the LLM prompt).

import { z } from 'zod'

/* ------------------------------------------------------------------ basics */

export const idSchema = z.string().trim().min(1, 'المعرّف مطلوب').max(64, 'المعرّف طويل أوي')

/** Free text from a human — trimmed, length-capped, control chars stripped. */
export const textSchema = (max: number, message = `النص لازم يكون أقل من ${max} حرف`) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim())
    .pipe(z.string().max(max, message))

/** Money/int field: integer piastres, never a float, never negative by default. */
export const piastresSchema = z
  .number()
  .int('المبلغ لازم يكون رقم صحيح بالقروش')
  .nonnegative('المبلغ مينفعش يكون بالسالب')
  .max(1_000_000_000, 'المبلغ كبير أوي')

export const httpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), 'الرابط لازم يبدأ بـ http:// أو https://')

/* ------------------------------------------------------------- chat route */

export const chatPostSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  text: textSchema(4000, 'الرسالة طويلة أوي (الحد ٤٠٠٠ حرف)').pipe(
    z.string().min(1, 'الرسالة فاضية'),
  ),
  modelKey: z.string().trim().max(120).nullish(),
  conversationId: idSchema.nullish(),
  suggestionId: z.string().trim().max(80).nullish(),
  deepResearch: z.boolean().optional().default(false),
})

/* -------------------------------------------------------------- operations */

export const confirmOpSchema = z.object({
  action: z.enum(['approve', 'reject', 'cancel'], {
    message: 'action لازم يكون approve أو reject أو cancel',
  }),
  userId: idSchema,
  reason: textSchema(500, 'السبب طويل أوي').optional(),
})

/* --------------------------------------------------------------- providers */

export const providerCreateSchema = z.object({
  name: textSchema(60, 'اسم المزوّد طويل أوي').pipe(z.string().min(2, 'اسم المزوّد قصير أوي')),
  baseUrl: httpUrlSchema,
  apiKey: z.string().trim().min(1, 'مفتاح الـ API مطلوب').max(400, 'المفتاح طويل أوي'),
})

export const providerUpdateSchema = z.object({
  models: z
    .array(
      z.object({
        remoteId: z.string().trim().min(1).max(200),
        label: textSchema(80).optional(),
        tier: z.enum(['air', 'balanced', 'deep']).default('balanced'),
        enabled: z.boolean().default(true),
      }),
    )
    .max(200, 'عدد الموديلات كبير أوي'),
})

/* ------------------------------------------------------------ memory/tools */

export const memoryPostSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  kind: z.enum(['fact', 'preference', 'rule', 'lexicon', 'insight']).default('fact'),
  category: textSchema(40).optional().default('general'),
  text: textSchema(1000, 'الملاحظة طويلة أوي').pipe(z.string().min(2, 'الملاحظة قصيرة أوي')),
  entityRef: z.string().trim().max(80).nullish(),
  confidence: z.number().int().min(0).max(100).optional(),
})

export const memoryPatchSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  id: idSchema,
  active: z.boolean().optional(),
  text: textSchema(1000).optional(),
  pinned: z.boolean().optional(),
})

export const toolPostSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  name: textSchema(60, 'اسم الأداة طويل أوي').pipe(z.string().min(2, 'اسم الأداة قصير أوي')),
  kind: z.enum(['web_source', 'webhook']),
  config: z.record(z.string(), z.unknown()).default({}),
})

/* --------------------------------------------------------------- scheduled */

export const taskPostSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  conversationId: idSchema.nullish(),
  title: textSchema(200, 'عنوان المهمة طويل أوي').pipe(z.string().min(2, 'عنوان المهمة قصير أوي')),
  tool: z.string().trim().min(1).max(60).default('remind'),
  fields: z.record(z.string(), z.unknown()).optional().default({}),
  whenLabel: textSchema(60).optional().default('بكرة'),
  scheduledFor: z.coerce.date().optional(),
  recurrence: z.enum(['daily', 'weekly', 'monthly', 'none']).nullish(),
})

/* ------------------------------------------------------------ quick commands */

export const quickCommandSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  label: textSchema(40, 'الاسم طويل أوي').pipe(z.string().min(1, 'الاسم مطلوب')),
  prompt: textSchema(1000, 'الأمر طويل أوي').pipe(z.string().min(1, 'الأمر مطلوب')),
  icon: z
    .enum(['spark', 'boxes', 'users', 'wallet', 'chart', 'book', 'today', 'alert'])
    .default('spark'),
  sortOrder: z.number().int().min(0).max(999).optional(),
})

/* -------------------------------------------------------------- conversations */

export const conversationPostSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  title: textSchema(80).optional(),
})

export const conversationPatchSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  conversationId: idSchema,
  title: textSchema(80).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
})

/* -------------------------------------------------------------- notes */

export const notePostSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  conversationId: idSchema,
  kind: z.enum(['fact', 'hypothesis', 'todo', 'plan', 'citation']).default('fact'),
  text: textSchema(1000, 'الملاحظة طويلة أوي').pipe(z.string().min(2, 'الملاحظة قصيرة أوي')),
  source: z.string().trim().max(200).nullish(),
})

/* ------------------------------------------------------------- inventory import */

export const itemImportSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
  /** Raw CSV text — header row required (اسم / سعر الشراء / سعر البيع / الكمية …). */
  csv: z.string().min(1, 'الملف فاضي').max(2_000_000, 'الملف كبير أوي (الحد ٢ ميجا)'),
  /** Update existing items (matched by name) instead of skipping them. */
  updateExisting: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
})

/* ------------------------------------------------------------------ helpers */

export type ParseOk<T> = { ok: true; data: T }
export type ParseFail = { ok: false; message: string }

/**
 * Parse a JSON request body against a schema.
 * Every failure mode (bad JSON, wrong shape) collapses into one Arabic message
 * so routes stay three lines long.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<ParseOk<z.infer<T>> | ParseFail> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, message: 'مفيش بيانات صحيحة في الطلب' }
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    const path = first?.path?.join('.')
    const message = first?.message ?? 'البيانات مش مظبوطة'
    return { ok: false, message: path ? `${message} (${path})` : message }
  }
  return { ok: true, data: result.data }
}
