import { NextRequest, NextResponse } from 'next/server'
import { Type } from '@google/genai'
import { getGeminiClient } from '@/lib/agent/llm'
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
    const gate = await guard(req, { scope: 'admin' })
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
      // Legacy multi-step provisioning could partially write fabricated balances.
      // Onboarding now saves actor preferences only; provisioning has its own atomic API.
      return NextResponse.json({ error: 'مسار التأسيس القديم متوقف. استخدم إعداد حسابك أو إنشاء نشاط فارغ، واستيراد البيانات بمراجعة مستقلة.' }, { status: 410 })
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
2. استخرج فقط الأصناف والأسعار والكميات المذكورة صراحة وبوضوح في الصورة أو الرسالة في extractedItems بالجنيه المصري. لا تقترح أو تخترع أي صنف أو سعر أو كمية أو رصيد. لو قيمة لازمة مش واضحة اترك الصنف خارج extractedItems واطلب استكمالها؛ لو مفيش بيانات ارجع []. الاقتراحات مش بيانات جاهزة للاستيراد.
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
              ...parsed,
              ok: true, analysisOnly: true, requiresReview: true, source: 'gemini',
            })
          }
        } catch (err) {
          console.warn(`[onboarding/analyze] Gemini (${modelName}) fallback:`, err instanceof Error ? err.message : err)
        }
      }
    }

    // Analysis failure must never invent starter products, prices, stock or OCR.
    return NextResponse.json({ ok: false, error: 'تحليل الصور أو استخراج البيانات غير متاح من غير موديل حقيقي متصل. لم نحلل صورة ولم ننشئ كتالوجًا أو أرصدة.', extractedItems: [], extractedParties: [], suggestedPlugins: [], suggestedRules: [] }, { status: 503 })
  } catch (err) {
    console.error('[onboarding/analyze] error:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'تعذر تحليل البيانات' },
      { status: 500 },
    )
  }
}
