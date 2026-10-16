// وكيل mock-provider — OpenAI-compatible streaming mock LLM on port 3031.
//
// R29: this service is now a real PROTOCOL FIXTURE, not just a text generator.
// Reason: in a sandbox/CI/air-gapped install there is no `.z-ai-config` and no
// reachable BYO provider, so the agent's *whole* model-facing contract — the
// intent JSON, the tool-call JSON, the streaming shape — was never exercised in
// the live preview. The symptom the owner saw was a chat that answered with
// canned prose while tools, drafts and the plan never ran.
//
// It now answers the three prompts the harness actually sends:
//
//   1. INTENT PASS  — a system prompt asking for a JSON intent →
//                     {"intent":"read|write","tool":…,"opType":…,"fields":…}
//   2. BRAIN LOOP   — a system prompt listing tools →
//                     {"tool_calls":[{"tool":"…","args":{…}}]} for work, or
//                     plain Arabic text when the message is just conversation
//   3. REPLY PASS   — prose, with the real numbers echoed back
//
// Plus `GET /search?q=` so «ابحث في الويب» is demonstrable without credentials.
// Everything stays deterministic enough to assert on: the same Arabic sentence
// always produces the same intent and tool call.

const PORT = Number(process.env.MOCK_PORT ?? 3031);

interface Msg { role: string; content: string }
interface TierCfg { sentences: [number, number]; reasoning: [number, number]; pace: [number, number]; rPace: [number, number] }

const MODELS = ["wakil-mock-air", "wakil-mock-flash", "wakil-mock-balanced", "wakil-mock-deep"] as const;

const TIERS: Record<string, TierCfg> = {
  "wakil-mock-air": { sentences: [1, 2], reasoning: [3, 3], pace: [8, 13], rPace: [90, 180] },
  "wakil-mock-flash": { sentences: [1, 2], reasoning: [3, 4], pace: [8, 16], rPace: [90, 200] },
  "wakil-mock-balanced": { sentences: [2, 3], reasoning: [4, 5], pace: [11, 20], rPace: [110, 220] },
  "wakil-mock-deep": { sentences: [3, 4], reasoning: [5, 6], pace: [14, 25], rPace: [130, 260] },
};

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

// ---------------------------------------------------------------------------
// Arabic intent detection — the same vocabulary the real model is asked for.
// [regex, opType, agent tool]
const WRITE_MAP: [RegExp, string, string][] = [
  [/تعيين|عدل مخزون|مخزون.*يبقى|الجرد/, "stock_adjustment", "record_stock_adjustment"],
  [/تحصيل|قبضت|استلمت من|حصلت/, "collection", "record_collection"],
  [/اشتراك|عضوية|تجديد|جددت/, "membership", "register_member"],
  [/حضر|حضور|لعب حصة|خلص تدريب/, "attendance", "record_attendance"],
  [/سددت|سداد|دفعت للمورد|دفع للمورد/, "payment", "record_payment"],
  [/مصروف|مصاريف|صرفت/, "expense", "record_expense"],
  [/اشتريت|شرا|جبت من المورد/, "purchase", "record_purchase"],
  [/بيع|بعت/, "sale", "record_sale"],
  [/ضيف (عميل|عضو)|اضف (عميل|عضو)/, "customer_add", "register_customer"],
  // «ضيف أحمد كمان من اللي عليهم فلوس» — a NAME after ضيف/اضف is a new party
  [/^\s*(?:ضيف|اضف|اضيف)\s+(?!لي\b)[^\s]+/, "customer_add", "register_customer"],
  [/ضيف مورد|اضف مورد/, "supplier_add", "register_supplier"],
];

// [regex, read tool]
const READ_MAP: [RegExp, string][] = [
  [/خزنة|كاش|رصيد الخزنة|فلوس معايا/, "get_cash_position"],
  // «ايه اللي ناقص عندي؟» — the owner's word for low stock is «ناقص», and the
  // expiry patterns above already own «قرب ينتهي / صلاحية».
  [/ناقص|نواقص|مخزون ناقص|تحت الحد/, "list_low_stock"],
  [/هيخلص|ينتهي|هينتهي|صلاحية|قرب يخلص|قربت تخلص|قرب ينتهي/, "list_expiring"],
  // gym: «عمر الشناوي عضويته باقي قد إيه؟» — a NAME before the noun. The list
  // question «مين اللي عضويته قربت تخلص؟» must NOT become a lookup for a member
  // called «مين اللي» (live R29), so question words are excluded here and the
  // expiry rule above already owns the sentence.
  [/(?!مين\s|اللي\s|هو\s|هي\s|فين\s|كام\s)\S+\s+(?:عضويته|اشتراكه|عضويه|اشتراك)/, "get_member_status"],
  [/حاله العضو|حاله عضو|وضع العضو/, "get_member_status"],
  // «الجبنة الرومي عندي كام كيلو؟»
  [/عندي كام|معايا كام|فاضل كام|باقي كام|رصيد (?:ال)?[^\s]+/, "get_item_stock"],
  [/اللي علينا|الموردين|مستحقات الموردين/, "list_payables"],
  [/اللي ليا|عليها فلوس|عليهم فلوس|مديون|مين عليه|عليه كام|عليها كام|باقي عليه/, "list_receivables"],
  [/بربح|هامش|مكسب|بكسب/, "get_profit_margin"],
  [/هينقص|معدل البيع|متوقع/, "forecast_stockout"],
  [/ملف العميل|بيسدد|بيحاسب/, "get_customer_history"],
  [/قارن|احسن من|أحسن من|اللي فات/, "compare_periods"],
  [/انصحني|انصح|نصايح|نصيحه|تحلل|حلل|رأيك|ازاي اطور|ازاي ازود|ازاي اقلل|ازاي احسن|قراءه شغلي/, "business_advice"],
  [/ابحث|دور في النت|على النت|في الويب|سعر السوق/, "search_web"],
  [/بتتصرف|مصروفات|مصاريف/, "expense_breakdown"],
  [/آخر الحركات|اخر الحركات|العمليات/, "get_activity_history"],
  [/سعر|بكام/, "search_catalog"],
  [/ملخص|النهارده|حال اليوم/, "get_daily_summary"],
];

const REASONING_POOL = [
  "بقرأ رسالتك كويس…",
  "بحدّد نوع العملية المطلوبة…",
  "بجمع الأرقام والتفاصيل…",
  "بشوف قواعد العمل والمخاطر…",
  "بجهّز الصياغة النهائية…",
  "بتأكد إن كل حاجة مظبوطة…",
];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => "chatcmpl-mock-" + Math.random().toString(16).slice(2, 10);
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

/** «٥٠٠» → 500 · «٣.٥» → 3.5 — the harness sends a mix of both digit systems. */
function toNum(raw: string): number {
  let out = "";
  for (const ch of raw) {
    const i = AR_DIGITS.indexOf(ch);
    out += i >= 0 ? String(i) : ch;
  }
  return Number(out.replace(/[^\d.]/g, ""));
}

const lastUser = (messages: Msg[]): string => ([...messages].reverse().find((m) => m.role === "user")?.content ?? "").trim();
/** The OWNER's sentence — the first user message. The harness appends tool
 *  results and instructions as later user messages, and reading THOSE as «the
 *  request» made the fixture answer small talk on write turns (R29 bug). */
const firstUser = (messages: Msg[]): string => (messages.find((m) => m.role === "user")?.content ?? "").trim();
/**
 * Tool results the harness fed BACK to us — the messages after the owner's
 * first one. Scanning the system prompt too was a live bug: the agent's
 * scratchpad/history mention OLD draft refs («مسودة WKL-3021»), so the fixture
 * announced a draft for a turn that only read a table.
 */
const resultText = (messages: Msg[]): string =>
  messages.slice(1).filter((m) => m.role === "user" || m.role === "tool").map((m) => m.content ?? "").join("\n");
/** «اكتب ردك النهائي … بلا JSON خالص» → prose, whatever the system prompt says. */
const isFinalAsk = (messages: Msg[]): boolean => /ردك النهائي|بلا JSON|نص عادي بلا/.test(lastUser(messages));
const systemText = (messages: Msg[]): string => messages.filter((m) => m.role === "system" || m.role === "assistant").map((m) => m.content).join("\n");

/** Is this the intent pass, the brain loop, or the reply pass? */
function passOf(messages: Msg[]): "intent" | "brain" | "reply" {
  // The harness's LAST request in a brain turn asks for the final prose with
  // «… كنص عادي بلا JSON خالص» — if we answered with tool_calls JSON there, the
  // turn ended with an EMPTY reply and the owner saw the canned chip wall.
  if (isFinalAsk(messages)) return "reply";
  const sys = systemText(messages);
  if (/tool_calls|"tool"\s*:|أدوات|tool/i.test(sys) && /اقرأ|استخدم|اختر|اختيار|قرر/.test(sys)) return "brain";
  if (/"intent"|قصد|intent/.test(sys)) return "intent";
  if (/tool_calls/.test(sys)) return "brain";
  return "reply";
}

/** Detect the write/read intent of an Arabic sentence (shared by both passes). */
function detect(text: string): { kind: "write" | "read" | "chat"; opType?: string; tool?: string; qty?: number; amount?: number; name?: string; itemName?: string } {
  const isQuestion = /[؟?]/.test(text);
  // «انصحني إزاي أقلل المصاريف» is ADVICE, not an expense entry — the word
  // «مصاريف» alone used to make the fixture draft a payment (live R29).
  const isAdvice =
    /(انصحني|انصح|نصيحه|نصايح|ازاي اقلل|ازاي ازود|ازاي اطور|ازاي احسن|حلل|قيم شغلي|راجعلي)/.test(text) &&
    !/(^|\s)(صرفت|مصروف)/.test(text);
  const write = isAdvice ? undefined : WRITE_MAP.find(([re]) => re.test(text));
  // «أحمد عليه كام؟» → THAT customer's file, never the whole receivables table
  const whose = text.match(/(?:^|\s)((?:[^\s،,؟?]+\s+){0,2}[^\s،,؟?]+)\s+(?:عليه|عليها)\s*(?:كام|قد ايه|قدايه|بكام)/);
  const read = READ_MAP.find(([re]) => re.test(text));
  const numbers = (text.match(/[\d٠-٩]+(?:[.٫][\d٠-٩]+)?/g) ?? []).map(toNum).filter((n) => Number.isFinite(n) && n > 0);
  // «بـ٤٠» is the PRICE, never the quantity: a fixture that sent 40 as qty billed
  // «بيع ٤٠ كيلو» for «بعت علبة … بـ٤٠» (live R29). A number glued to a unit word
  // is the quantity; a «بـN / بسعر N» clause is the money.
  const priceClause = text.match(/(?:بـ|بسعر|بمبلغ|بـ)\s*([\d٠-٩][\d٠-٩.,]*)/);
  const unitNum = text.match(/([\d٠-٩][\d٠-٩.,]*)\s*(?:كيلو|كيلوجرام|جرام|جم|لتر|علبه|علبة|علب|كيس|اكياس|شريط|قرص|اقراص|قطعه|قطعة|كرتونه|كرتونة|باكيت|برطمان|طبق|زجاجه|زجاجة)/);
  const price = priceClause ? toNum(priceClause[1]) : undefined;
  const qty = unitNum ? toNum(unitNum[1]) : price != null ? 1 : numbers[0];
  const amount = price ?? (priceClause ? undefined : numbers[1] ?? numbers[0]);
  const nameMatch = text.match(/(?:من|لـ|ل|لأ|الى|إلى|على)\s+([^،,.؟?\d]+)$/) ?? text.match(/^(?:ضيف|اضف)\s+([^\s،,]+)/);
  const itemMatch = text.match(/(?:بعت|بيع|اشتريت|شرا|جبت)\s+[\d٠-٩.]*\s*[^\s]*\s*([^،,]+?)(?:\s+(?:لـ|ل|لأ|من|بـ)|$)/);
  // a QUESTION about an operation is a READ (unless it is clearly an instruction)
  if (write && !isQuestion) {
    return { kind: "write", opType: write[1], tool: write[2], qty, amount, name: nameMatch?.[1]?.trim(), itemName: itemMatch?.[1]?.trim() };
  }
  if (whose && !/^(مين|اللي|هو|هي|على|فلان)$/.test(whose[1].trim())) {
    return { kind: "read", tool: "get_customer_history", qty, amount, name: whose[1].trim() };
  }
  if (read) return { kind: "read", tool: read[1] };
  if (write && isQuestion) return { kind: "read", tool: "get_activity_history" };
  return { kind: "chat" };
}

/** The messages the intent pass expects: a JSON object, nothing else. */
function intentJson(text: string): string {
  const d = detect(text);
  if (d.kind === "write") {
    return JSON.stringify({
      intent: "write",
      opType: d.opType,
      fields: {
        ...(d.itemName ? { itemName: d.itemName } : {}),
        ...(d.qty ? { qty: d.qty } : {}),
        ...(d.amount ? { amount: d.amount } : {}),
        ...(d.name ? { customerName: d.name, name: d.name } : {}),
        ...((d.opType === "customer_add" || d.opType === "supplier_add") && /(?:وعليه|وعليها|عليه|عليها)\s*(?:بـ|ب)?\s*([\d٠-٩]+)/.test(text)
          ? { balance: toNum(text.match(/(?:وعليه|وعليها|عليه|عليها)\s*(?:بـ|ب)?\s*([\d٠-٩]+)/)![1]) }
          : {}),
      },
    });
  }
  if (d.kind === "read") return JSON.stringify({ intent: "read", tool: d.tool, fields: queryArgs(text, d.tool!) });
  return JSON.stringify({ intent: "chat", fields: {} });
}

/** Tool arguments for a read tool (query/name/days where they apply). */
function queryArgs(text: string, tool: string): Record<string, unknown> {
  if (tool === "search_catalog") {
    const q = text.replace(/^.*?(?:سعر|بكام|ابحث عن|دور على)\s*/, "").replace(/[؟?].*$/, "").trim();
    return { query: q.slice(0, 40) || text.slice(0, 40) };
  }
  if (tool === "get_item_stock") {
    const m =
      text.match(/(?:رصيد|مخزون)\s+([^\s،,؟?]+(?:\s+[^\s،,؟?]+)?)/) ??
      text.match(/([^\s،,؟?]+(?:\s+[^\s،,؟?]+)?)\s+(?:عندي|معايا|فاضل|باقي)/);
    return { name: (m?.[1] ?? text).replace(/[؟?].*$/, "").trim().slice(0, 40) };
  }
  if (tool === "get_customer_history" || tool === "get_member_status") {
    const before = text.match(/([^\s،,؟?]+(?:\s+[^\s،,؟?]+)?)\s+(?:عضويته|اشتراكه)/);
    if (before) return { name: before[1].trim().slice(0, 30) };
    const whose = text.match(/(?:^|\s)((?:[^\s،,؟?]+\s+){0,2}[^\s،,؟?]+)\s+(?:عليه|عليها|عليهم)\s*(?:كام|قد ايه|قدايه|بكام)/);
    if (whose) return { name: whose[1].replace(/^(و|هو|هي|العميل|العميله)\s+/, "").trim().slice(0, 30) };
    const m = text.match(/(?:من|لـ|ل|على|العميل|العميلة|ملف)\s+([^،,.؟?]+)$/) ?? text.match(/^\s*([^\s،,.؟?]+)\s+(?:عليه|عليها|بيسدد|بيدفع)/);
    return { name: (m?.[1] ?? "").replace(/^(العميل|بتاع|من)\s*/, "").trim().slice(0, 30) };
  }
  if (tool === "search_web") {
    const q = text
      .replace(/^(ابحث|دور|فتش)\s*(لي|ليا)?\s*(في|على)?\s*(النت|الويب|الانترنت|جوجل)?\s*(عن|على)?\s*/, "")
      .replace(/[؟?].*$/, "")
      .trim();
    return { query: q.slice(0, 80) || text.slice(0, 80) };
  }
  if (tool === "get_activity_history" || tool === "forecast_stockout" || tool === "expense_breakdown") {
    return { days: 14 };
  }
  return {};
}

/** The brain loop expects tool calls, or a final Arabic sentence. */
function brainReply(rawText: string, model: string): string {
  // the owner's ask is the FIRST user message; later user messages are tool
  // results + instructions from the harness (see firstUser)
  const text = rawText;
  const d = detect(text);
  if (d.kind === "write") {
    const args: Record<string, unknown> = {
      ...(d.itemName ? { item: d.itemName } : {}),
      ...(d.qty ? { qty: d.qty } : {}),
      ...(d.amount ? { amount: d.amount } : {}),
      ...(d.name ? { name: d.name, customerName: d.name } : {}),
    };
    // «وعليه ٢٥٠» → an opening balance for a brand-new party
    if (d.opType === "customer_add" || d.opType === "supplier_add") {
      const mb = text.match(/(?:وعليه|وعليها|عليه|عليها|رصيده|مديونيته)\s*(?:بـ|ب)?\s*([\d٠-٩]+)/);
      if (mb) args.balance = toNum(mb[1]);
    }
    return JSON.stringify({ tool_calls: [{ tool: d.tool, args }] });
  }
  if (d.kind === "read") {
    // A compound request («الخزنة والنواقص») becomes ONE programmatic plan call —
    // exactly what the harness's run_plan exists for.
    const multi = READ_MAP.filter(([re]) => re.test(text))
    if (multi.length >= 2 && /و|كمان|زيادة/.test(text)) {
      return JSON.stringify({
        tool_calls: [
          {
            tool: "run_plan",
            args: { plan: multi.slice(0, 4).map(([, tool]) => ({ tool, args: queryArgs(text, tool) })) },
          },
        ],
      })
    }
    return JSON.stringify({ tool_calls: [{ tool: d.tool, args: queryArgs(text, d.tool!) }] })
  }
  const cfg = TIERS[model] ?? TIERS["wakil-mock-balanced"]
  void cfg
  return "تحت أمرك يا فندم — أنا وكيل الشغل بتاعك. قولّي تحب نعمل إيه: بيع، شرا، تحصيل، أو سؤال عن المخزون والخزنة؟";
}

function buildReply(model: string, messages: Msg[]): { reasoning: string[]; content: string } {
  const cfg = TIERS[model] ?? TIERS["wakil-mock-balanced"];
  const n = Math.round(rnd(cfg.reasoning[0], cfg.reasoning[1]));
  const reasoning = [...REASONING_POOL].sort(() => Math.random() - 0.5).slice(0, n);
  const text = lastUser(messages);
  const pass = passOf(messages);
  // The OWNER's ask is always the first user message; the harness appends tool
  // results + instructions afterwards.
  const ownerText = firstUser(messages) || text;

  if (pass === "intent") return { reasoning, content: intentJson(ownerText) };
  if (pass === "brain") return { reasoning, content: brainReply(isFinalAsk(messages) ? text : ownerText, model) };

  // REPLY PASS — the fixture behaves like a GOOD model: it reads the tool
  // results the harness fed back and speaks about THEM, it never claims a card
  // that does not exist, and it never buries a failure behind small talk.
  const d = detect(ownerText);
  const nums = (ownerText.match(/[\d٠-٩]+/g) ?? []).slice(0, 3).join("، ");
  const results = resultText(messages);
  const failures = [...results.matchAll(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((e) => !/مكرر/.test(e));
  const refs = [...results.matchAll(/"ref"\s*:\s*"(WKL-\d+)"/g)].map((m) => m[1]);
  const summaries = [...results.matchAll(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  // A card came back (any read tool) → point at the real data, not at nothing.
  const cardish = /"kind"\s*:\s*"(kv|table|sources|text|draft)"/.test(results);

  let content: string;
  if (failures.length > 0 && refs.length === 0) {
    // the operation did NOT happen — say it plainly, with the tool's own reason
    content = `مش قادر أخلّص دي يا فندم — ${failures[0].split("—")[0].trim()}. العملية ماتسجلتش خالص، وقولّي أعمل إيه وأنا أنفّذ.`;
  } else if (refs.length > 0) {
    content = `جهزتلك مسودة ${refs[0]}${summaries[0] ? `: ${summaries[0]}` : ""} — مستنية اعتمادك.`;
  } else if (cardish) {
    content = `دي بيانات سجلك الحقيقي${nums ? ` — فيها أرقام زي ${nums}` : ""}. التفاصيل كلها في الكارت تحت.`;
  } else if (d.kind === "write") {
    content = `تمام يا فندم — فهمت إنها ${d.opType}. العملية اللي زي دي بتتحرك فلوس والمفروض توصلك كمسودة تستنى اعتمادك${nums ? ` بالأرقام دي (${nums})` : ""}.`;
  } else if (d.kind === "read") {
    content = `أكيد — دي بيانات السجل الحقيقي${nums ? ` وفيها أرقام زي ${nums}` : ""}. التفاصيل كلها في الكارت تحت.`;
  } else {
    content = "تحت أمرك يا فندم — أنا وكيل الشغل بتاعك. قولّي تحب نعمل إيه: بيع، شرا، تحصيل، أو سؤال عن المخزون والخزنة؟";
  }
  return { reasoning, content };
}

async function chat(req: Request) {
  let body: { model?: string; messages?: Msg[]; stream?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return json({ error: { message: "messages[] is required" } }, 400);
  const model = (MODELS as readonly string[]).includes(body.model ?? "") ? body.model! : "wakil-mock-balanced";
  const { reasoning, content } = buildReply(model, messages);
  const id = uid();
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    return json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", reasoning_content: reasoning.join(" "), content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 96, completion_tokens: 48, total_tokens: 144 },
    });
  }

  const cfg = TIERS[model] ?? TIERS["wakil-mock-balanced"];
  const enc = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (s: string) => ctrl.enqueue(enc.encode(s));
      send(chunk({ role: "assistant" }));
      for (const r of reasoning) {
        send(chunk({ reasoning_content: r }));
        await sleep(rnd(cfg.rPace[0], cfg.rPace[1]));
      }
      const chars = Array.from(content);
      // JSON answers stream fast (they are machine-read); prose keeps the
      // deliberate letter-by-letter pacing the UI is built around.
      const jsonPass = content.trim().startsWith("{");
      for (let i = 0; i < chars.length; ) {
        const take = jsonPass ? chars.length : Math.random() < 0.5 ? 1 : 2;
        send(chunk({ content: chars.slice(i, i + take).join("") }));
        i += take;
        if (!jsonPass) await sleep(rnd(cfg.pace[0], cfg.pace[1]));
      }
      send(chunk({}, "stop"));
      send("data: [DONE]\n\n");
      ctrl.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// /search — the fixture behind «ابحث في الويب» (see src/lib/agent/websearch.ts)
const MARKET_NOTES: [RegExp, string][] = [
  [/جبن|رومي/, "الجبنة الرومي في السوق المصري النهارده بين ١٤٠ و١٩٠ جنيه للكيلو حسب النوع، والمتوسط ١٦٥."],
  [/لبن|حليب/, "أسعار اللبن في مصر: كرتونة اللتر بين ٣٨ و٤٨ جنيه، والكيلو السائب بين ٣٠ و٣٦."],
  [/رز|أرز/, "الرز المصري العادي بين ٢٨ و٣٨ جنيه للكيلو على مستوى الجمهورية."],
  [/زيت/, "زيت عافية وعافية: العبوة ٨٠٠ مل بين ٦٢ و٧٥ جنيه، واللتر بين ٧٥ و٩٠."],
  [/سكر/, "السكر المعبأ في مصر بين ٣٢ و٣٨ جنيه للكيلو."],
  [/عنبر|عطور|مسك/, "العنبر الخام بيتباع بين ٦٠ و٩٠ جنيه للجرام حسب الجودة والنقاء."],
];

function search(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const num = Math.min(10, Math.max(1, Number(searchParams.get("num") ?? 5) || 5));
  const note = MARKET_NOTES.find(([re]) => re.test(q))?.[1];
  const host = "market-watch.example";
  const results = [
    {
      title: `أسعار السوق: ${q || "مؤشرات عامة"}`,
      url: `https://${host}/prices?q=${encodeURIComponent(q)}`,
      snippet: note ?? `متوسط أسعار «${q || "السلع الأساسية"}» في السوق المصري مع تحديث يومي من ٣ مصادر.`,
    },
    {
      title: `نشرة أسعار الجملة — ${q || "سوق العبور"}`,
      url: `https://${host}/wholesale?q=${encodeURIComponent(q)}`,
      snippet: "أسعار الجملة اليوم من سوق العبور، مع مقارنة الأسبوع الحالي بالأسبوع الماضي.",
    },
    {
      title: `تحليل سوقي: ${q || "قطاع التجزئة"}`,
      url: `https://${host}/analysis?q=${encodeURIComponent(q)}`,
      snippet: "تحليل موجز لحركة السعر والعرض خلال آخر ٣٠ يوم مع توقع الاتجاه للأسبوع القادم.",
    },
  ];
  return json({ query: q, results: results.slice(0, num), provider: "wakil-mock-search" });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (pathname === "/health") return json({ ok: true, models: MODELS, search: true });
    if (pathname === "/search" && req.method === "GET") return search(req);
    if (pathname === "/v1/models" && req.method === "GET")
      return json({ object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 1735689600, owned_by: "wakil" })) });
    if (pathname === "/v1/chat/completions" && req.method === "POST") return chat(req);
    return json({ error: { message: `Unknown route: ${req.method} ${pathname}` } }, 404);
  },
});

console.log("mock-provider: OpenAI-compatible mock LLM + /search listening on port " + PORT);
