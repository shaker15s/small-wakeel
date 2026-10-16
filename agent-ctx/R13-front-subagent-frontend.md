# R13-front — subagent-frontend (chat screen rebuild to ChatGPT/Claude quality)

Task ID: R13-front
Agent: subagent-frontend
Scope (owned files only): src/components/chat/* + src/lib/api.ts

## What was built / verified

- **ChatView.tsx** — full rewrite to ChatGPT/Claude quality:
  - Root `flex h-full min-h-0 flex-col` (fits AppShell's exact-height `main`; NO calc hacks, no page scrollbar).
  - Compact header: AgentAvatar(sm, live state: thinking/writing/error/idle) + business name + vertical label | ModelPicker popover.
  - Messages: `flex-1 min-h-0` scroll area (`scroll-warm px-3 py-4 sm:px-4`) + inner `mx-auto max-w-2xl flex-col gap-5`.
  - **ChatGPT turn order (the user's #1 complaint — FIXED):** card/cards/actions arriving via SSE mid-stream are BUFFERED in closure refs and never rendered while deltas stream. Only on `done` they're patched into the turn and revealed BELOW the finished text with staggered framer motion (initial {opacity:0,y:10}, 220ms ease-out, delay i*80ms). Verified by DOM polling: cards=0 while text grows, cards=1 after done.
  - Live turn lives INSIDE the turns list via the same MessageBubble (no flicker on finalize; `doneId` captured at handler-call time so final deltas in the same flush aren't dropped).
  - Smart scroll: near-bottom-only auto-follow + floating 40px circular scroll-to-bottom button (scale-in, ChevronDown, shadow) that appears only when scrolled up.
  - Welcome hero for empty conversations (AgentAvatar lg idle, «أهلاً بيك 👋», vertical.welcome, example chips as staggered pill buttons that send on click).
  - Failed turn → error alert + «جرّب تاني» retry (resends previous user text); loading skeleton; approve/reject flow preserved (busyOpId + toasts + outcome patch + query invalidation).
- **ThinkingIndicator.tsx (NEW)** — three animation modes ROTATING every 2.8s (bounce iMessage dots → fade scale+opacity appear/disappear → wave 5-bar equalizer), rotating Egyptian status text every 2.2s (وكيل بيفكر… / بحلل طلبك… / بدوّر في سجلك… / بحسب الأرقام… / بجهّز الرد…), latest live thinking step as muted second line with spinner→emerald-check. Pure framer-motion (zero globals.css edits). showAvatar prop (false inside MessageBubble rows that already render the avatar).
- **MessageBubble.tsx** — pure-RTL ChatGPT geometry: user `justify-end` (physical LEFT, WhatsApp-ARABIC mirror) amber-soft bubble `rounded-2xl rounded-tl-sm max-w-[85%]`; assistant row with AgentAvatar at physical RIGHT + column: name row («وكيل» + HH:mm + modelLabel Cpu chip), ThinkingBlock (finalized), streamed text with `.stream-caret` + compact step line, hover CopyButton (desktop-only `hidden sm:flex`, Copy→emerald Check 1.5s), ActionCard/ResultCards/ChatActions revealed with motion below text. withNums digit wrapping. MotionConfig reducedMotion="user" at root.
- **ChatActions.tsx (NEW)** — deep-link pill buttons (chart→BarChart3, boxes→Boxes, users→Users, wallet→Wallet, today→LayoutGrid, journal→BookOpen, book→FileText), tone primary/outline, h-10 rounded-full, .press, stagger 60ms, click → onNavigate(view).
- **ModelPicker (in ChatView)** — shadcn Popover rebuilt + FIXED («مش بقدر اختار الموديلات»): outline rounded-full h-9 trigger (Cpu amber + label + rotating chevron), w-64 content: builtin-deep/builtin-air rows + «مزوّدين خارجيين» section from api.providers() (only enabled), footer hint. Active row bg-accent/70 + amber Check (spring scale-in). Select → setModel + toast «تم تبديل الموديل» + close. Verified: localStorage wakil.modelKey persists for builtin-air AND ext:{id}; NEXT reply's modelLabel badge reflects the switch (builtin-air → «خفيف سريع…», external → «وكيل خفيف · wakil-mock-air · مزوّد خارجي» streamed via mock-provider :3031).
- **Composer.tsx** — ChatGPT-style unified input pill (rounded-3xl, focus-within amber ring), autosize textarea (44→128px), chips h-8 with hover lift + fill-and-focus, 44px circular primary send with ArrowUp → Loader2 spin while sending, mic stays disabled teaser, mobile safe-area padding in ChatView wrapper.
- **ThinkingBlock.tsx** — collapsed by default («تفكير وكيل · X خطوات» + rotating chevron), step icons + done checks + active pulse; no setState-in-effect (lint-clean derived pattern).
- **lib/api.ts** — `onActions` handler + `case 'actions'` in streamChat; `messageToTurn` maps `m.actions`.

## Fixes applied during this pass
1. Double avatar during live thinking (MessageBubble rendered AgentAvatar AND ThinkingIndicator its own) → showAvatar={false}.
2. CopyButton was `hidden` without `sm:flex` → never displayed → added `sm:flex`.
3. Reveal transition aligned to spec: 220ms ease-out (was spring).

## QA (agent-browser, isolated named session — the default session is SHARED with parallel agents and caused cross-talk)
- Viewport fill: desktop 1440×900 + mobile 390×844 → pageScroll:false (no page scrollbar), single scroll container, composer above mobile tab bar, no horizontal overflow.
- Full stream lifecycle polled: pre-text (indicator, 0 cards) → deltas (text grows + caret, cards=0) → done (card + actions revealed below text). Same for the draft card («سجّل بيع ربع كيلو كركديه» → WKL-5017).
- Approve flow: busy spinner (disabled + Loader2) → toast → card status «تم — موثّق ومتحقق» + «التحقق بعد التنفيذ» section → DB SUCCEEDED. Gym WKL-2012 approval → FAILED_SAFE rendered correctly (genuine verification failure of a stale seeded op).
- Deep links: «افتح المخزون» → Inventory view active; «لوحة اليوم» rendered; identity reply («انت مين») shows rich persona + 2 action buttons.
- Scroll-to-bottom button: appears at top, 40px, click → smooth scroll, disappears at bottom.
- Welcome hero: fresh user (زبير) → «أهلاً بيك» + example chip click sends.
- Failed turn: aborted /api/chat via network route → error alert + «جرّب تاني» + destructive toast → unroute + retry → resent + streamed + card.
- Copy button: exists, desktop display verified (clipboard write is permission-denied in headless — graceful no-op by design).
- Dark mode: html.dark, body rgb(15,26,43), user bubble rgb(58,47,28).
- ZERO console/page errors (HMR noise only). `bun run lint` exit 0. `bunx tsc --noEmit`: zero errors in my files (remaining project errors are other agents' scope: examples/, mini-services/, skills/, harness.ts).
- dev.log: clean (all 200s).

## Deviations / notes for orchestrator
- R3 reason input: could NOT be re-triggered live this round (backend classified the test stock-adjustment draft as non-R3; pharmacy conversation has no pending card) — ActionCard's R3 reason gating logic is byte-identical to the R12-verified code (Input + approve disabled until trim≥3).
- Server modelLabel for builtin-air says «glm-4.6» while my picker sub-label (per spec) says «glm-4.5-air» — backend label is R13-ai's choice; noted, not changed.
- DB state changes from my QA: attar WKL-5017 (karkade sale) SUCCEEDED with verification; gym WKL-2012 (seeded pending renewal) now FAILED_SAFE — the seeded gym approval demo is consumed; re-seed if needed.
- 'actions' SSE event IS live (R13-ai shipped it) — deep-link buttons render + persist; absence is handled gracefully (buf.actions stays null).
- Clipboard writeText fails in headless (permissions) — the CopyButton catches and no-ops silently; on real browsers it flips to the emerald check.
