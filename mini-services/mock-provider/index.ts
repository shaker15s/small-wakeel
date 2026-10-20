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
  // «اعكس الشرا…» — reversal FIRST: «شرا» inside it would otherwise read as
  // a brand-new purchase (live R41).
  [/اعكس|اعكسي|اعكسلي|العكس|ارجع العملية|ارجع الشرا|ارجع البيع|امسح العملية/, "reversal", "reverse_operation"],
  [/تعيين|عدل مخزون|مخزون.*يبقى|الجرد/, "stock_adjustment", "record_stock_adjustment"],
  [/تحصيل|قبضت|استلمت من|حصلت/, "collection", "record_collection"],
  [/اشتراك|عضوية|تجديد|جددت/, "membership", "register_member"],
  [/حضر|حضور|لعب حصة|خلص تدريب/, "attendance", "record_attendance"],
  [/سددت|سداد|دفعت للمورد|دفع للمورد/, "payment", "record_payment"],
  [/مصروف|مصاريف|صرفت/, "expense", "record_expense"],
  // «جبت 100 صفيحه سمنه» — جبت + a number is a purchase too (R41: the owner
  // reports a delivery, not always «جبت من المورد»).
  [/اشتريت|شرا|جبت من المورد|جبت\s+[\d٠-٩]/, "purchase", "record_purchase"],
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
  // «مين خد بضاعه؟» — goods that went out on account = receivables.
  [/خد بضاعه|اخد بضاعه|بضاعه على حساب|خدها على حساب/, "list_receivables"],
  // «مين سدد؟» — who settled: the activity history shows it.
  [/مين سدد|مين دفع|من سدد|السدادات|سدادات/, "get_activity_history"],
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

// R41: IMEs and web copy-paste leak zero-width + bidi controls INTO words
// («تقد\u200cر», «عامل\u200fايه»). The fixture's keyword regexes matched the raw
// text, so a single invisible char turned a real question into «unknown» →
// canned small-talk — exactly what felt like «البرومبت مبيروح للموديل».
// Same hygiene as the app's normalizeAr (src/lib/agent/arabic.ts):
// word-separators become a space, true joiners are removed, tashkeel/tatweel
// and Arabic-Indic digits are folded so the patterns can see the words.
const stripInvisible = (t: string): string =>
  t
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060\u2061\u2062\u2063\u2064\u2065\u206A-\u206F\uFEFF\u00AD]/g, " ")
    .replace(/[\u200C\u200D]/g, "")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const lastUser = (messages: Msg[]): string => stripInvisible([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
/** The OWNER's CURRENT ask — the last user message that is not a tool-result
 *  injection. Real dialogue history rides as EARLIER user messages, and the
 *  harness appends tool results + instructions as LATER ones (prefixed «نتايج
 *  الأدوات»); reading either as «the request» made the fixture answer about a
 *  stale turn (R29 first-user bug, R41 history leak). */
const ownerAsk = (messages: Msg[]): string => {
  const users = messages.filter((m) => m.role === "user");
  for (let i = users.length - 1; i >= 0; i--) {
    const c = (users[i].content ?? "").trim();
    if (!c) continue;
    if (/^نتايج الأدوات/.test(c)) continue;
    return stripInvisible(c);
  }
  return lastUser(messages);
};
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
function detect(text: string): { kind: "write" | "read" | "chat" | "schedule"; opType?: string; tool?: string; qty?: number; amount?: number; name?: string; itemName?: string; schedule?: { title: string; when: string; recurrence?: string; tool: string } } {
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
  // A new party: the NAME comes right after «ضيف/اضف» and stops at the first
  // qualifier («من اللي عليهم فلوس» · «وعليه ٤٥٠»), never the whole sentence.
  const addMatch = text.match(/^(?:ضيف|اضف|اضيف)\s+(?:لي\s+)?(?:عميل(?:ه)?|عضو|مورد(?:ين)?|زبون|راجل|ست|حاج)?\s*(.+)$/);
  const addName = addMatch
    ? addMatch[1]
        .split(/\s+(?:كمان|من\s+اللي|من\s+الذين|اللي\s+عليهم|اللي\s+علينا|وعليه|وعليها|عليه|عليها|وبيدفع|بيحاسب|لحد|عشان|من\s+ايام|من\s+أيام|من\s+تاريخ)\s+/)[0]
        .replace(/[،,؟?].*$/, "")
        .trim()
    : undefined;
  const nameMatch = addName ? [addName, addName] : (text.match(/(?:من|لـ|ل|لأ|الى|إلى|على)\s+([^،,.؟?\d]+)$/) ?? text.match(/(?:^|\s)ل\s*([^،,.؟?\d][^،,.؟?\d]*)$/) ?? text.match(/^(?:ضيف|اضف)\s+([^\s،,]+)/)); // glued «لكابتن حسام» / «ضيف فلان»
  // Item name: qty + unit consumed, name captured up to a ROLE preposition
  // (ل/لأ/من/بـ) or a و-continuation («جبت 100 صفيحه سمنه ودفعتله 1000»).
  const itemMatch = text.match(/(?:بعت|بيع|اشتريت|شرا|جبت)\s+[\d٠-٩.]*\s*[^\s]*\s*([^،,]+?)(?=\s+(?:لـ|ل|لأ|من|بـ|و)|$)/);
  // an explicit reminder verb owns the sentence («فكرني بفلان بكرة 10 الصبح»)
  const sched = parseSchedule(text);
  if (sched) return { kind: "schedule" as const, schedule: sched };
  if (/(فكرني|فكريني|ذكرني|ذكريني|تذكيرني|تذكيري)/.test(text)) {
    return { kind: "schedule" as const, schedule: null }; // verb, no clock → ask
  }
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

/** «فكرني بجرد المخزون بكرة 10 الصبح» → a scheduled task. The harness
 *  re-validates (Cairo clock must be explicit + future; recurrence whitelisted)
 *  — we only parse, we never assume a time. Evening parts of day shift the
 *  hour («2 العصر» = 14:00), quarters map to 15/30/45. */
function parseSchedule(text: string): { title: string; when: string; recurrence?: string; tool: string } | null {
  if (!/(فكرني|فكريني|ذكرني|ذكريني|تذكيرني|تذكيري)/.test(text)) return null;
  const recurrence = /كل يوم|يومياً|يومي/.test(text) ? "daily"
    : /كل اسبوع|اسبوعي|اسبوعيا/.test(text) ? "weekly"
    : /كل شهر|شهري|شهريا/.test(text) ? "monthly" : undefined;
  const dayWords = /بعد بكره|بكره|بكرة|النهارده|النهاردة|اليوم|غدًا|غدا|السبت|الاحد|الاثنين|التلات|الاربع|الخميس|الجمعه/;
  const explicitDay = text.match(/بعد بكره/)?.[0] ?? text.match(dayWords)?.[0] ?? null;
  // clock: a bare number in the middle of a sentence is NOT a time — the hour
  // must be followed by a colon, a quarter/half word, a day-part word, or EOL
  // NOTE: JS \b does NOT work for Arabic letters (they are not \w) — guard
  // with an explicit Arabic-letter lookahead instead.
  const hm = text.match(/(?<!\d)([1-9]|1[0-2])(?::([0-5]\d))?\s*(?:والربع|و ربع|ونص|والنص)?\s*(?=\s+(?:الصبح|صباح|العصر|المساء|الليل)(?![\u0600-\u06FF])|$)/);
  if (!hm) return null; // no clock → the harness asks for a clear future time
  let hour = parseInt(hm[1], 10);
  let minute = hm[2] ? parseInt(hm[2], 10) : /والربع|و ربع/.test(text) ? 15 : /ونص|والنص/.test(text) ? 30 : 0;
  if (/المساء|الليل|بالليل|بتاعة الليل/.test(text) && hour < 12) hour += 12;
  if (/العصر|بالعصر/.test(text) && hour < 12) hour += 12;
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  // day: explicit word wins. Without one a one-shot means today (the harness
  // rejects a past time with a clear message); a RECURRING task whose time
  // already passed today rolls to tomorrow — «كل يوم 9 الصبح» at night means
  // the next morning, never the one that just went by.
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const day = explicitDay ?? (recurrence && hour * 60 + minute <= nowMin ? "بكره" : "النهارده");
  // title = whatever survives after removing the schedule machinery
  let title = text
    .replace(/فكرني|فكريني|ذكرني|ذكريني|تذكيرني|تذكيري/g, " ")
    .replace(/كل يوم|يومياً|يومي|كل اسبوع|اسبوعي|اسبوعيا|كل شهر|شهري|شهريا/g, " ")
    .replace(/بعد بكره|بكره|بكرة|النهارده|النهاردة|اليوم|غدًا|غدا|السبت|الاحد|الاثنين|التلات|الاربع|الخميس|الجمعه/g, " ")
    .replace(hm[0], " ")
    .replace(/والربع|و ربع|ونص|والنص|تلات ارباع|الصبح|صباح|العصر|المساء|الليل|بالليل|بتاعة الليل|بالعصر/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) title = "تذكير";
  // a topic that maps to a real read report runs that report; else a plain reminder
  const tool = /مخزون|نواقص|ناقص/.test(title) ? "list_low_stock"
    : /خزانه|خزنة|كاش|رصيدها/.test(title) ? "get_cash_position"
    : /مديون|عليهم|تحصيل|لهم/.test(title) ? "list_receivables"
    : "remind";
  return { title, when: `${day} ${clock}`, recurrence, tool };
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
  // the owner's CURRENT ask (see ownerAsk) — history and tool-result
  // injections are user messages too and must not be read as the request
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
    // «اشتراك سنوي» — the plan word is a field, not the name
    if (d.opType === "membership") {
      const plan = /سنوي|سنه/.test(text) ? "سنوي" : /شهري|شهرا/.test(text) ? "شهري" : /ربع/.test(text) ? "ربع" : undefined;
      if (plan) args.plan = plan;
    }
    // «جبت 100 صفيحه سمنه ودفعتله 1000 بس» — the number after a payment verb
    // is the CASH handed over (a partial payment is fine), never the total.
    if (d.opType === "purchase" && d.amount != null && /دفع|دفعت|دفعتله|خلصت|ادفع/.test(text)) {
      args.paid = d.amount;
    }
    // reversal: a WKL ref, if the owner typed one — otherwise the harness
    // resolves the most recent matching operation from the summary.
    if (d.opType === "reversal") {
      const r = text.match(/WKL-\d+/);
      if (r) args.ref = r[0];
    }
    // R41 multi-intent: one sentence, two jobs — «ملخص اليوم وبعت ٥ عود».
    // The read word must sit at a segment boundary (start / after و / كمان /
    // comma) so a write continuation («…ودفعتله 1000 بس النهارده») never
    // fans out into a spurious second tool.
    const calls: { tool: string; args: Record<string, unknown> }[] = [{ tool: d.tool, args }];
    const READ_BOUNDARY =
      /(^|[و،,]|\sو\s*)(?:ملخص|النهارده|النهارده|الوضع|الخزنه|الخزنة|كاش|نواقص|ناقص|مبيعات|مصاريف|مصروفات|اللي ليا|اللي عليهم|اللي علينا|مستحقات|مديون)/;
    if (READ_BOUNDARY.test(text)) {
      const readHit = READ_MAP.find(([re]) => re.test(text));
      if (readHit) calls.push({ tool: readHit[1], args: queryArgs(text, readHit[1]) });
    }
    return JSON.stringify({ tool_calls: calls });
  }
  if (d.kind === "schedule" && !d.schedule) {
    return "تمام — بس اكتبلي الموعد بالتفصيل وأنا أحتفظ بالمهمة: «فكرني بمراجعة الحسابات بكرة 5 العصر».";
  }
  if (d.kind === "schedule" && d.schedule) {
    const sc = d.schedule;
    return JSON.stringify({
      tool_calls: [{
        tool: "schedule_task",
        args: {
          title: sc.title,
          whenLabel: sc.when,
          when: sc.when,
          ...(sc.recurrence ? { recurrence: sc.recurrence } : {}),
          tool: sc.tool,
          fields: {},
        },
      }],
    });
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
  // ---- no tool matched: CONVERSE like an employee, never a wall. ----
  // A rude probe gets a calm human answer, a capability question gets the
  // real capabilities, and anything else is echoed + steered to what works —
  // with rotation so the fixture never sounds like a broken record.
  const hash = [...text].reduce((s, c) => s + c.codePointAt(0), 0)
  if (/اهبل|هبل|غبي|مسخرة|تافه|عديم|.useless/.test(text)) {
    return "ههه — مش اهبل يا فندم، بس لو في حاجة عملتها غلط اكتبها بالظبط وأنا أصلحها فورًا. اعملي خير: اكتب اللي عايزه وأنا شغال."
  }
  if (/مهمه مجدوله|مهام مجدوله|تقدر|تعمل (?:مهمه|اكتر|أكتر)|اكتر من (?:مهمه|طلب|شغل)|تسألني|تسألنى|وتكمل شغل|وسالني/.test(text)) {
    return "إيه طبعًا يا فندم — ده شغلي بالضبط: (١) أجدول مهمة بوقتها وتنفذ لوحدها (قولي: «فكرني بجرد المخزون كل يوم 9 الصبح»). (٢) أعمل أكتر من طلب في رسالة واحدة — زي «ملخص النهارده وبعت 5 عود». (٣) لو ناقصني رقم أو اسم، أكمّلك سؤال واحد وأكمّل الشغل من غير ما نبدأ من الأول. جرب دلوقتي — اكتب «فكرني بفلان بكرة 10 الصبح»."
  }
  const echo = text.replace(/[؟?]+$/, "").trim().slice(0, 70)
  const fallbacks = [
    `فهمتك — «${echo}». من سجلك أقدر أطلعك على: الخزنة، المخزون والنواقص، مين خد بضاعه ومين سدد (مديونيات العملاء والموردين)، وملخص اليوم والأسبوع. اكتب أي واحدة بالكلام العادي وأنا أعملها فورًا.`,
    `وصلتني — «${echo}». لو دي عن أرقام الشغل (خزنة، مخزون، مديونيات، ملخص) اكتبها وأنا أجيبها من السجل. ولو سؤال عام — في الديمو ده شغلي الأساسي هو أرقام سجلك.`,
    `قصدك «${echo}»؟ في الديمو ده شغال على أرقام سجلك: الخزنة، المخزون، مديونيات العملاء والموردين، والملخصات — اطلب أي واحد بالكلام العادي.`,
  ]
  return fallbacks[hash % fallbacks.length]
}

function buildReply(model: string, messages: Msg[]): { reasoning: string[]; content: string } {
  const cfg = TIERS[model] ?? TIERS["wakil-mock-balanced"];
  const n = Math.round(rnd(cfg.reasoning[0], cfg.reasoning[1]));
  const reasoning = [...REASONING_POOL].sort(() => Math.random() - 0.5).slice(0, n);
  const text = lastUser(messages);
  const pass = passOf(messages);
  // The OWNER's current ask — the last real user message (ownerAsk skips
  // history + tool-result injections).
  const ownerText = ownerAsk(messages) || text;

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
  let body: { model?: string; messages?: Msg[]; stream?: boolean; tools?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return json({ error: { message: "messages[] is required" } }, 400);
  const model = (MODELS as readonly string[]).includes(body.model ?? "") ? body.model! : "wakil-mock-balanced";
  // Audit trail: one line per request so «is my prompt reaching the provider?»
  // is answerable from the process log, not guessed.
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const sysChars = messages.filter((m) => m.role === "system").reduce((n, m) => n + String(m.content ?? "").length, 0);
  const toolsN = Array.isArray(body.tools) ? body.tools.length : 0;
  console.log(`[mock] model=${model} msgs=${messages.length} sysChars=${sysChars} tools=${toolsN} user="${String(lastUser).slice(0, 90).replace(/\n/g, " ")}"`);
  const { reasoning, content } = buildReply(model, messages);
  const id = uid();
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    // Native tool calling: when the harness sent a `tools` schema array and
    // this is a tool-call answer, return REAL OpenAI tool_calls (not JSON in
    // text) — exactly what DeepSeek/OpenAI/OpenRouter do on the wire.
    if (toolsN > 0 && typeof content === "string" && content.trim().startsWith("{") && content.includes('"tool_calls"')) {
      try {
        const parsed = JSON.parse(content) as { tool_calls?: { tool?: string; args?: Record<string, unknown> }[] };
        const native = (parsed.tool_calls ?? []).filter((c) => typeof c?.tool === "string").map((c, i) => ({
          id: `call_${i + 1}`,
          type: "function",
          function: { name: c.tool, arguments: JSON.stringify(c.args ?? {}) },
        }));
        if (native.length > 0) {
          return json({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: native }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 96, completion_tokens: 48, total_tokens: 144 },
          });
        }
      } catch {
        /* not tool JSON after all — fall through to text */
      }
    }
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

async function dispatch(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (pathname === "/health") return json({ ok: true, models: MODELS, search: true });
  if (pathname === "/search" && req.method === "GET") return search(req);
  if (pathname === "/v1/models" && req.method === "GET")
    return json({ object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 1735689600, owned_by: "wakil" })) });
  if (pathname === "/v1/chat/completions" && req.method === "POST") return chat(req);
  return json({ error: { message: `Unknown route: ${req.method} ${pathname}` } }, 404);
}

const hasBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
if (hasBun) {
  (globalThis as Record<string, unknown>).Bun.serve({ port: PORT, fetch: dispatch as (req: Request) => Response | Promise<Response> });
} else {
  // Plain-node fallback (sandbox without the bun binary): bridge node:http to
  // the same WHATWG dispatch, streaming the SSE body chunk by chunk.
  const { createServer } = await import("node:http");
  const server = createServer(async (nodeReq, nodeRes) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const c of nodeReq) chunks.push(c as Uint8Array);
      const init: RequestInit & { duplex?: "half" } = {
        method: nodeReq.method ?? "GET",
        headers: new Headers(nodeReq.headers as Record<string, string>),
      };
      if (nodeReq.method === "POST" || nodeReq.method === "PUT") {
        init.body = new Uint8Array(Buffer.concat(chunks as Buffer[])) as unknown as BodyInit;
        init.duplex = "half"; // node's undici requires it for request bodies
      }
      const res = await dispatch(new Request(`http://127.0.0.1${nodeReq.url ?? "/"}`, init));
      nodeRes.statusCode = res.status;
      res.headers.forEach((v, k) => nodeRes.setHeader(k, v));
      if (res.body) {
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          nodeRes.write(Buffer.from(value));
        }
      } else {
        nodeRes.end(await res.text());
      }
      nodeRes.end();
    } catch (e) {
      if (!nodeRes.headersSent) nodeRes.statusCode = 500;
      nodeRes.end(String(e));
    }
  });
  server.listen(PORT, () => {
    console.log("mock-provider (node fallback): listening on port " + PORT);
  });
}

console.log("mock-provider: OpenAI-compatible mock LLM + /search listening on port " + PORT);
