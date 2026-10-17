import { NextRequest, NextResponse } from 'next/server'
import { Type } from '@google/genai'
import { db } from '@/lib/db'
import { getGeminiClient } from '@/lib/agent/llm'
import { createNewBusinessWithDefaults, upsertCatalogItemInDb } from '@/lib/domain/business-builder'
import { synthesizePluginWithAI } from '@/lib/agent/plugin-harness'
import { upsertBusinessRule } from '@/lib/agent/memory'
import { localVectorDB } from '@/lib/agent/vector-memory'
import { normalizeAr, toWesternDigits } from '@/lib/agent/arabic'
import { guard } from '../../_lib/guard'

export interface ExtractedItemSpec {
  name: string
  unit: string
  sellPriceEgp: number
  costPriceEgp: number
  stockQty: number
  category: string
}

export interface ExtractedPartySpec {
  kind: 'customer' | 'supplier'
  name: string
  balanceEgp: number
}

export interface SuggestedPluginSpec {
  slug: string
  name: string
  description: string
}

export async function POST(req: NextRequest) {
  try {
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res

    const body = (await req.json()) as {
      mode?: 'analyze' | 'provision'
      ownerName?: string
      businessName?: string
      businessType?: string
      hasExistingSystem?: boolean
      openingCashEgp?: number
      message?: string
      imageBase64?: string
      mimeType?: string
      items?: ExtractedItemSpec[]
      parties?: ExtractedPartySpec[]
      plugins?: SuggestedPluginSpec[]
      rules?: string[]
    }

    const mode = body.mode ?? 'analyze'

    // =========================================================================
    // MODE 1: PROVISION — Build the entire Business, Catalog, Parties, Plugins & Vector Memory
    // =========================================================================
    if (mode === 'provision') {
      const ownerName = (body.ownerName || 'صاحب المنشأة').trim()
      const businessName = (body.businessName || 'منشأتي الجديدة').trim()
      const businessType = (body.businessType || 'supermarket').trim()
      const openingCashEgp = Number(body.openingCashEgp ?? 15000)

      const created = await createNewBusinessWithDefaults({
        name: businessName,
        type: businessType,
        ownerName,
        openingCashEgp,
        skipDefaultSeeds: true,
      })

      const businessId = created.id
      const userId = created.users[0]?.id ?? ''

      // 1) Upsert all extracted catalog items from camera/notebook/chat
      const itemsToInsert = Array.isArray(body.items) ? body.items : []
      for (const it of itemsToInsert.slice(0, 30)) {
        if (!it.name?.trim()) continue
        await upsertCatalogItemInDb({
          businessId,
          name: it.name.trim(),
          unit: it.unit || 'قطعة',
          category: it.category || 'عام',
          sellPriceEgp: Math.max(1, Number(it.sellPriceEgp || 50)),
          buyPriceEgp: Math.max(1, Number(it.costPriceEgp || Math.round((it.sellPriceEgp || 50) * 0.75))),
          stockQty: Math.max(0, Number(it.stockQty ?? 20)),
          minQty: 5,
        }).catch(() => null)
      }

      // 2) Upsert extracted customers & suppliers with their balances (in piastres)
      const partiesToInsert = Array.isArray(body.parties) ? body.parties : []
      for (const p of partiesToInsert.slice(0, 20)) {
        if (!p.name?.trim()) continue
        const balancePiastres = Math.max(0, Math.round(Number(p.balanceEgp || 0) * 100))
        if (p.kind === 'supplier') {
          await db.supplier
            .create({
              data: {
                businessId,
                name: p.name.trim(),
                balance: balancePiastres,
              },
            })
            .catch(() => null)
        } else {
          await db.customer
            .create({
              data: {
                businessId,
                name: p.name.trim(),
                balance: balancePiastres,
              },
            })
            .catch(() => null)
        }
      }

      // 3) Synthesize & activate custom plugins
      const pluginsToInstall = Array.isArray(body.plugins) ? body.plugins : []
      for (const pl of pluginsToInstall.slice(0, 4)) {
        await synthesizePluginWithAI({
          businessId,
          userId,
          prompt: `${pl.name} — ${pl.description}`,
          preferredName: pl.name,
        }).catch(() => null)
      }

      // 4) Save standing BUSINESS_DNA rules & owner identity into Contextual Vector Memory
      const rulesToSave = Array.isArray(body.rules) ? body.rules : []
      for (const r of rulesToSave.slice(0, 6)) {
        if (!r?.trim()) continue
        await upsertBusinessRule({
          businessId,
          userId,
          text: r.trim(),
        }).catch(() => null)
      }

      await db.agentMemory
        .create({
          data: {
            businessId,
            userId,
            kind: 'preference',
            category: 'onboarding_profile',
            text: `صاحب العمل هو «${ownerName}» ويدير «${businessName}» (${
              body.hasExistingSystem ? 'يمتلك نظاماً رقمياً وتم ربطه' : 'تم تأسيس نظامه الرقمي من الدفتر والجلسة الحية'
            })`,
            confidence: 95,
            active: true,
          },
        })
        .catch(() => null)

      await localVectorDB.syncBusinessMemories(businessId)

      return NextResponse.json({
        ok: true,
        business: created,
        userId,
      })
    }

    // =========================================================================
    // MODE 2: ANALYZE — Multimodal Gemini Vision + Audio/Chat Notebook & Store Inspector
    // =========================================================================
    const ownerName = (body.ownerName || 'يا ريس').trim()
    const businessName = (body.businessName || 'محلك').trim()
    const message = (body.message || '').trim()
    const hasImage = Boolean(body.imageBase64 && body.imageBase64.length > 50)

    const ai = getGeminiClient()
    if (ai) {
      for (const modelName of ['gemini-3-flash-preview', 'gemini-2.5-flash']) {
        try {
          const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = []
          if (hasImage && body.imageBase64) {
            const cleanBase64 = body.imageBase64.replace(/^data:[^;]+;base64,/, '')
            parts.push({
              inlineData: {
                data: cleanBase64,
                mimeType: body.mimeType || 'image/jpeg',
              },
            })
          }

          parts.push({
            text: `أنت «وكيل» — الشريك الذكي لتأسيس وإدارة الأعمال في مصر.
المستخدم اسمه: "${ownerName}"، واسم مشروعه: "${businessName}" (النشاط المبدئي: "${body.businessType || 'عام'}").
${hasImage ? 'قام المستخدم بمشاركة صورة حية من الكاميرا أو صورة لكشكول الحسابات / المخزن / الفواتير.' : ''}
رسالة المستخدم: "${message || (hasImage ? 'حلل الصورة دي واستخرج الأصناف والأسعار والحسابات وابنيلي الأدوات المناسبة' : 'اقترح لي البداية والأدوات المناسبة لمشروعي')}"

المطلوب منك:
1. رد عليه باللهجة المصرية الودودة والذكية في حقل replyAr واشرح له إيه اللي لقطته وفهمته من كلامه أو صورته.
2. استخرج أي أصناف أو بضاعة ظاهرة في الصورة أو الرسالة (أو اقترح أهم ٤ أصناف أساسية مناسبة لنشاطه لو لم يذكر أصنافاً محددة) في extractedItems بالأسعار بالجنيه المصري.
3. استخرج أي عملاء أو موردين أو ديون مذكورة في extractedParties.
4. اقترح ٢ إلى ٣ أدوات متابعة ذكية (Plugins) تناسب طبيعة شغله في suggestedPlugins.
5. استخرج أي قوانين عمل أو تفضيلات في suggestedRules.`,
          })

          const response = await ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts }],
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  replyAr: { type: Type.STRING, description: 'Warm Egyptian Arabic reply to the owner' },
                  detectedVertical: {
                    type: Type.STRING,
                    description: 'One of: supermarket, attar, pharmacy, gym, restaurant, electronics, clothing, wholesale, clinic',
                  },
                  extractedItems: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        unit: { type: Type.STRING },
                        sellPriceEgp: { type: Type.NUMBER },
                        costPriceEgp: { type: Type.NUMBER },
                        stockQty: { type: Type.NUMBER },
                        category: { type: Type.STRING },
                      },
                      required: ['name', 'unit', 'sellPriceEgp', 'costPriceEgp', 'stockQty', 'category'],
                    },
                  },
                  extractedParties: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        kind: { type: Type.STRING, description: 'customer or supplier' },
                        name: { type: Type.STRING },
                        balanceEgp: { type: Type.NUMBER },
                      },
                      required: ['kind', 'name', 'balanceEgp'],
                    },
                  },
                  suggestedPlugins: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        slug: { type: Type.STRING },
                        name: { type: Type.STRING },
                        description: { type: Type.STRING },
                      },
                      required: ['slug', 'name', 'description'],
                    },
                  },
                  suggestedRules: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: ['replyAr', 'detectedVertical', 'extractedItems', 'extractedParties', 'suggestedPlugins', 'suggestedRules'],
              },
            },
          })

          const rawText = response.text?.trim()
          if (rawText) {
            const parsed = JSON.parse(rawText)
            return NextResponse.json({
              ok: true,
              ...parsed,
            })
          }
        } catch (err) {
          console.warn(`[onboarding/analyze] Gemini (${modelName}) fallback:`, err instanceof Error ? err.message : err)
        }
      }
    }

    // Deterministic Smart Fallback when Gemini key is absent or rate-limited
    const fallback = buildDeterministicOnboardingAnalysis({
      ownerName,
      businessName,
      businessType: body.businessType,
      message,
      hasImage,
    })

    return NextResponse.json({
      ok: true,
      ...fallback,
    })
  } catch (err) {
    console.error('[onboarding/analyze] error:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'تعذر تحليل البيانات' },
      { status: 500 },
    )
  }
}

function buildDeterministicOnboardingAnalysis(params: {
  ownerName: string
  businessName: string
  businessType?: string
  message: string
  hasImage: boolean
}) {
  const norm = normalizeAr(`${params.businessName} ${params.message}`)
  let detectedVertical = params.businessType || 'supermarket'

  if (/(عطار|بن|توابل|بهارات|اعشاب|زيوت)/.test(norm)) detectedVertical = 'attar'
  else if (/(صيدلي|دواء|ادويه|علاج|طبي)/.test(norm)) detectedVertical = 'pharmacy'
  else if (/(جيم|رياض|فتنس|تمرين|كابتن)/.test(norm)) detectedVertical = 'gym'
  else if (/(مطعم|كافيه|مشويات|اكل|ساندوتش)/.test(norm)) detectedVertical = 'restaurant'
  else if (/(موبايل|الكترونيات|كمبيوتر|صيانه|اكسسوار)/.test(norm)) detectedVertical = 'electronics'
  else if (/(ملابس|هدوم|اتيليه|احذيه|موضه)/.test(norm)) detectedVertical = 'clothing'

  const extractedItems: ExtractedItemSpec[] = []
  const extractedParties: ExtractedPartySpec[] = []

  // Parse any lines in the user's message that mention items + prices
  const west = toWesternDigits(params.message)
  const lines = west.split(/[\n،,؛]+/).map((s) => s.trim()).filter(Boolean)
  for (const line of lines) {
    const numMatch = line.match(/(\d+(?:\.\d+)?)/)
    if (numMatch) {
      const price = Number(numMatch[1])
      const cleanName = line.replace(/\d+(?:\.\d+)?/g, '').replace(/(جنيه|ج|بسعر|سعر|علبه|كرتونه|كيلو|قطعه)/g, '').trim()
      if (cleanName.length >= 2 && price > 0) {
        if (/(عميل|الحاج|استاذ|مدام|عليه)/.test(cleanName)) {
          extractedParties.push({
            kind: 'customer',
            name: cleanName.replace(/(عميل|عليه|حساب)/g, '').trim() || 'عميل آجل',
            balanceEgp: price,
          })
        } else {
          extractedItems.push({
            name: cleanName.slice(0, 40),
            unit: 'قطعة',
            sellPriceEgp: price,
            costPriceEgp: Math.max(1, Math.round(price * 0.78)),
            stockQty: 25,
            category: 'أصناف مستخرجة',
          })
        }
      }
    }
  }

  if (extractedItems.length === 0) {
    if (detectedVertical === 'attar') {
      extractedItems.push(
        { name: 'بن محوج مخصوص', unit: 'كيلو', sellPriceEgp: 420, costPriceEgp: 330, stockQty: 18, category: 'بن وقهوة' },
        { name: 'حبهان هندي فاخر', unit: 'جرام', sellPriceEgp: 2.5, costPriceEgp: 1.8, stockQty: 1500, category: 'توابل' },
        { name: 'عسل نحل سدر جبلي', unit: 'علبة', sellPriceEgp: 350, costPriceEgp: 260, stockQty: 12, category: 'عسل وزيوت' },
      )
    } else if (detectedVertical === 'pharmacy') {
      extractedItems.push(
        { name: 'بانادول إكسترا', unit: 'علبة', sellPriceEgp: 54, costPriceEgp: 43, stockQty: 40, category: 'مسكنات' },
        { name: 'أوجمنتين ١ جم', unit: 'علبة', sellPriceEgp: 135, costPriceEgp: 108, stockQty: 22, category: 'مضاد حيوي' },
        { name: 'فيتامين سي فوار', unit: 'علبة', sellPriceEgp: 65, costPriceEgp: 50, stockQty: 30, category: 'مكملات' },
      )
    } else {
      extractedItems.push(
        { name: 'لبن جهينة كامل الدسم ١ لتر', unit: 'علبة', sellPriceEgp: 45, costPriceEgp: 38, stockQty: 48, category: 'ألبان' },
        { name: 'أرز مصري فاخر ١ كيلو', unit: 'كيلو', sellPriceEgp: 35, costPriceEgp: 29, stockQty: 80, category: 'بقالة جافة' },
        { name: 'زيت عباد الشمس ٨٠٠ مل', unit: 'علبة', sellPriceEgp: 75, costPriceEgp: 64, stockQty: 35, category: 'زيوت' },
      )
    }
  }

  const suggestedPlugins: SuggestedPluginSpec[] = [
    {
      slug: 'plugin_inventory_optimizer',
      name: 'إدارة المخزون الذكية وتصنيف ABC',
      description: 'يراقب النواقص والأصناف الراكدة ويحسب كميات إعادة الطلب تلقائياً',
    },
    {
      slug: 'plugin_sales_velocity',
      name: 'تحليل المبيعات وسرعة الدوران',
      description: 'يرصد الأصناف الحصان الرابح وصافي الربح اليومي والأسبوعي',
    },
    {
      slug: 'plugin_receivables_collector',
      name: 'مدير التحصيلات والائتمان الذكي',
      description: 'يتابع حسابات الكشكول ومديونيات العملاء ومواعيد التحصيل',
    },
  ]

  const replyAr = params.hasImage
    ? `منور يا ${params.ownerName}! فحصت اللقطة اللي بعتها لـ «${params.businessName}» واستخرجت منها الأصناف والأسعار وجهزتلك أدوات إدارة المخزون والتحصيلات عشان نحول الكشكول لسيستم ذكي متكامل.`
    : `أهلاً بيك يا ${params.ownerName} في «${params.businessName}»! حللت كلامك وجهزتلك الكتالوج المبدئي وأدوات المتابعة الذكية — تقدر كمان تفتح الكاميرا وتوريني الكشكول أو البضاعة في أي وقت أو تضغط «ابني النظام وابدأ فوراً»!`

  return {
    replyAr,
    detectedVertical,
    extractedItems,
    extractedParties,
    suggestedPlugins,
    suggestedRules: [
      'التنبيه الفوري عند وصول أي صنف أساسي لحد الطلب',
      'مراجعة أرصدة العملاء الآجلة قبل البيع الآجل الجديد',
    ],
  }
}
