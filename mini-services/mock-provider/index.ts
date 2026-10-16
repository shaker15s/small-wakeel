// وكيل mock-provider — OpenAI-compatible streaming mock LLM on port 3031
// Reasoning-first (DeepSeek-style reasoning_content deltas) + letter-by-letter content.

const PORT = 3031;

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

// [regex on last user message, Arabic op label, agent tool]
const OP_MAP: [RegExp, string, string][] = [
  [/تحصيل|قبضت|استلمت من/, "تحصيل من عميل", "record_collection"],
  [/اشتراك|عضوية|تجديد/, "اشتراك/تجديد عضوية", "renew_membership"],
  [/بيع|بعت/, "بيع", "draft_sale"],
  [/شرا|اشتري/, "شراء", "draft_purchase"],
  [/سددت|سداد|دفع(?:ت)? للمورد/, "سداد لمورد", "record_payment"],
  [/مصروف|مصاريف|دفعت/, "مصروف", "record_expense"],
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

function buildReply(model: string, messages: Msg[]): { reasoning: string[]; content: string } {
  const cfg = TIERS[model] ?? TIERS["wakil-mock-balanced"];
  const n = Math.round(rnd(cfg.reasoning[0], cfg.reasoning[1]));
  const reasoning = [...REASONING_POOL].sort(() => Math.random() - 0.5).slice(0, n);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = (lastUser?.content ?? "").trim();
  const hasTools = messages.some((m) => m.role === "system" && /tool|أداة|أدوات|وكيل/i.test(m.content));
  const nums = (text.match(/[\d٠-٩]+(?:\.\d+)?/g) ?? []).slice(0, 3).join("، ");
  const op = OP_MAP.find(([re]) => re.test(text));
  const isQ = /[؟?]/.test(text);

  let base: string;
  if (op && !isQ) {
    const [, label, tool] = op;
    base = `تمام يا فندم، فهمت — ${label}. جهّزتلك كارت العملية${nums ? ` بالأرقام دي (${nums})` : " بتفاصيل رسالتك"}${hasTools ? ` وهنفّذها من خلال أداة ${tool} بأمان` : ""}. راجعها وقولّي «أكّد» لو تمام أو عدّلني على أي حاجة.`;
  } else if (isQ && /خزن|نقدي|كاش|فلوس/.test(text)) {
    base = "حسب حركة النهارده، الخزنة في وضع مطمئن — الداخل أكبر من الخارج بفرق معقول. تحب أطلعلك تفاصيل الحركات واحدة واحدة؟";
  } else if (isQ && /مخزون|موجود|باقي|كمية|صنف/.test(text)) {
    base = "معظم الأصناف حالتها كويسة، بس فيه كام صنف قاربوا يخلصوا. أقدر أطلعهالك في قايمة مرتبة لو تحب.";
  } else if (hasTools) {
    base = "تحت أمرك يا فندم — أنا وكيل الشغل بتاعك. من رسالتك مفيش عملية محددة، فقولّي تحب نعمل إيه: بيع، شرا، تحصيل، مصروف، أو سؤال عن المخزون والخزنة؟";
  } else {
    base = "أهلاً يا فندم! أنا وكيلك — تحب نبدأ بإيه؟ بيع، شرا، مصروف، أو سؤال عن المخزون والخزنة؟";
  }

  const target = Math.round(rnd(cfg.sentences[0], cfg.sentences[1]));
  const extras = ["لو محتاج أي حاجة تانية أنا موجود.", "ولو تحب تفاصيل أكتر قولّي.", "وأقدر أجهّزلك ملخص النهارده في أي وقت.", "وتحت أمرك دايمًا."];
  let content = base;
  let count = (base.match(/[.؟!]/g) ?? []).length || 1;
  while (count < target && extras.length) { content += " " + extras.shift(); count++; }
  return { reasoning, content };
}

async function chat(req: Request) {
  let body: { model?: string; messages?: Msg[]; stream?: boolean };
  try { body = await req.json(); } catch { return json({ error: { message: "Invalid JSON body" } }, 400); }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return json({ error: { message: "messages[] is required" } }, 400);
  const model = (MODELS as readonly string[]).includes(body.model ?? "") ? body.model! : "wakil-mock-balanced";
  const { reasoning, content } = buildReply(model, messages);
  const id = uid();
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    return json({
      id, object: "chat.completion", created, model,
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
      for (let i = 0; i < chars.length;) {
        const take = Math.random() < 0.5 ? 1 : 2;
        send(chunk({ content: chars.slice(i, i + take).join("") }));
        i += take;
        await sleep(rnd(cfg.pace[0], cfg.pace[1]));
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

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/v1/models" && req.method === "GET")
      return json({ object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 1735689600, owned_by: "wakil" })) });
    if (pathname === "/v1/chat/completions" && req.method === "POST") return chat(req);
    return json({ error: { message: `Unknown route: ${req.method} ${pathname}` } }, 404);
  },
});

console.log("mock-provider: OpenAI-compatible mock LLM listening on port " + PORT);
