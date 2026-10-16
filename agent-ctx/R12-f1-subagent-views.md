# R12-f1 — subagent-views — Work Record

**Task**: 7 view screens in `src/components/views/` (Today / Inventory / Journal / Accounts / Stats / Reports / Settings incl. providers) for وكيل (Wakil) — Arabic RTL, TanStack Query v5, shadcn/ui, strict TS.

## What I read first (contracts)
- `/home/z/my-project/worklog.md` (component contracts, API contract, design system, QA baseline)
- `src/lib/{types,api,format,verticals,store}.ts`, `src/app/globals.css` (tokens/utilities), `src/lib/agent/tools.ts` (TYPE_AR/STATUS_AR), live API routes (`api/overview`, `api/providers`, `api/providers/[id]`, `api/tasks`, `api/memories`, `api/reports`) to confirm exact payload shapes.

## Files delivered (all in `src/components/views/`)
| File | Exports |
|---|---|
| `shared.tsx` | `ViewProps` ({businessId,userId,onNavigate?}), `TYPE_AR`, `STATUS_AR`, `RISK_AR`, `TIER_AR`, `TASK_STATUS_AR`, `READ_TOOL_AR`, `RECURRENCE_AR`, `safeView()`, `Money`, `RiskBadge`, `StatusBadge` (+`STATUS_TONE`), `TypeBadge`, `TierBadge`, `KpiCard` (fixed h-24), `LoadingKpis`, `ErrorState`, `EmptyState`, `SectionCard`, `ViewHeader`, `arNum` |
| `TodayView.tsx` | default `TodayView` — KPI row (خزنة/مبيعات/عمليات/مستنيات), alerts (danger/warning/info borders + clickable nav), pending approvals with «راجعها في المحادثة», low-stock top 5, pharmacy expiring section |
| `InventoryView.tsx` | default — search + category Tabs + desktop Table + mobile cards + ناقص/منتهية/قربت badges + total value footer, max-h-[480px] scroll-warm |
| `JournalView.tsx` | default — status chips + type Select + operation cards (ref mono, TYPE/STATUS/RISK badges, reversal link chip, userName + arDateTime), max-h-[560px] scroll-warm |
| `AccountsView.tsx` | default — receivables (teal) / payables (amber) cards lg:grid-cols-2, tel: links, totals |
| `StatsView.tsx` | default — 7d/30d Tabs, 4 KPIs, shadcn Chart grouped bars (navy/amber/muted, Arabic weekday x-axis, compact ar-EG y-axis, egp tooltip), topItems table, byType with share bars |
| `ReportsView.tsx` | default + `ReportsViewProps` (adds optional `businessName?`) — printable card (period, مصدر البيانات, generation date), totals kv, أرباح تقديرية big number, byType + topItems tables, «تصدير البيانات» → `/api/export?businessId=…` target=_blank, «اطبع» |
| `SettingsView.tsx` | default — (a) builtin models + providers CRUD (add dialog: test → fetch models → checkbox/label/tier/enable → save subset; per-model enable switches; delete via AlertDialog), model selection via `useWakil().setModel` (`builtin-*` / `ext:{id}`); (b) tasks (create + tick + list); (c) memories (add + list) |

## Key decisions & deviations
1. **TYPE_AR/STATUS_AR are NOT imported from `@/lib/agent/tools`** (despite worklog contract) — verified empirically that importing it from a client component drags `@prisma/client`'s browser shim + `lib/db`'s `new PrismaClient()` into the client chunk (probe: chunk `_678f0088._.js` contained 76 prisma refs + `globalForPrisma`). Duplicated the maps in `views/shared.tsx` with identical values. **Recommendation for orchestrator**: extract labels to a client-safe `lib/labels.ts` and re-export from tools.ts (R12-f2 chat atoms need them too).
2. **api.tasks shape mismatch**: `lib/api.ts` types `tasks()` as `ScheduledTaskDTO[]` but the route returns `{ tasks: [...] }` — SettingsView defensively accepts both shapes (works today, survives an orchestrator fix of api.ts).
3. **api.deleteProvider returns raw fetch** (no error parsing) — handled `res.ok` + Arabic body error in the view.
4. **Switch hit-area**: this sandbox's shadcn Switch is tiny (18px × 32px) — built `SwitchHit` wrapper (44×44, role="switch", keyboard support) with the visual Switch `pointer-events-none`.
5. Toasts via `useToast` from `@/hooks/use-toast` (layout mounts that Toaster — NOT sonner, despite worklog mention).
6. Chart uses `ChartContainer`/`ChartTooltipContent`/`ChartLegendContent` from `components/ui/chart.tsx` + recharts `BarChart`; data converted piastres→pounds for axis, tooltip formats back with `egpPlain × 100`.
7. Builtin model labels follow the task brief: «عميق مفكّر · glm-4.6» (deep) + «خفيف سريع · glm-4.6» (air). NOTE: worklog's registry says air = glm-4.5-air — followed the newer task instruction; orchestrator may align later.

## Verification (all passing)
- `bun run lint` → clean (exit 0). `bunx tsc --noEmit` → **zero errors in components/views** (remaining repo errors are in examples/, mini-services/, skills/ — other agents' scope).
- Dev server stayed 200 throughout; dev.log shows all API calls 200/201, no runtime errors.
- **Live headless-browser QA** (agent-browser, temp `__qa.tsx` harness + temp page.tsx swap — both fully reverted, harness deleted):
  - All 7 views rendered with real seeded data (supermarket + pharmacy for expiry logic).
  - TodayView: KPIs «٩٬٢٨٨ ج.م», alerts clickable, pending card «محتاجة سبب موثق» (R3), pharmacy «منتهية/باقي ٥ يوم» badges ✓.
  - Chart: 934×260 SVG, 21 bars (7d × 3 series), Arabic weekday ticks + compact ar numerals ✓.
  - Journal chip filter → only WKL-1013; type/Select present ✓.
  - Inventory search «لبن» → 1 row, footer total 2,400 ج.م ✓; mobile = 20 cards, desktop = table.
  - Model selection: builtin-air → localStorage `wakil.modelKey=builtin-air`; ext model → `ext:{id}` ✓; switch toggle persisted to DB and reverted ✓.
  - **Full provider flow vs mock-provider :3031**: empty-field validation error (Arabic) → add + model fetch (4 models) → uncheck one + rename one + save subset → DB showed exactly 3 models with the custom label → delete via AlertDialog → DB back to 2 seeded providers ✓.
  - Task create + tick (toast «مفيش مهام مستحقة دلوقتي») ✓; memory add ✓ (both QA rows deleted afterwards via project Prisma client — DB restored to seed state).
  - Toasts render in the mounted Toaster viewport ✓.
  - Mobile 390×844: `scrollWidth == clientWidth` (no horizontal overflow), all buttons ≥32px, switches 44×44 ✓.
  - Dark mode (manual `.dark` class): bg `rgb(15,26,43)` + card `rgb(22,36,58)` from the wakil dark palette ✓.
- Zero browser console errors.

## Out of scope honored
No changes outside `src/components/views/` (page.tsx swap was temporary and byte-identical restored; DB QA rows cleaned up).
