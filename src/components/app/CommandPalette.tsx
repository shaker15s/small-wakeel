'use client'

// وكيل — لوحة البحث السريع (⌘K / Ctrl+K).
//
// WHY: the owner's mental model is a person, an item or a receipt number, not a
// screen. Before this, finding «أم حسن» meant opening «الحسابات» and typing in
// that screen's filter; finding operation 1032 meant scrolling the journal.
// One box now searches items, customers, suppliers, operations and notes at
// once (`GET /api/search`), with:
//   • keyboard-first navigation (↑ ↓ Enter Esc) and Arabic-Indic-aware matching
//   • grouped results with the same tones the rest of the app uses
//   • a jump-to-view fallback so an item result always lands somewhere useful
//
// The palette is mounted once (next to AppShell) so it works from the chat
// screen AND from every app view, including via the global shortcut.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { Boxes, CornerDownLeft, FileText, Search, Users, Wallet, X } from 'lucide-react'

import { api, type SearchHitDTO } from '@/lib/api'
import { useWakil } from '@/lib/store'
import { cn } from '@/lib/utils'
import { arNum } from '@/components/views/shared'

const KIND_META: Record<
  SearchHitDTO['kind'],
  { label: string; icon: typeof Boxes; view: 'inventory' | 'accounts' | 'journal' | 'memory' }
> = {
  item: { label: 'الأصناف', icon: Boxes, view: 'inventory' },
  customer: { label: 'العملاء', icon: Users, view: 'accounts' },
  supplier: { label: 'الموردين', icon: Wallet, view: 'accounts' },
  operation: { label: 'العمليات', icon: FileText, view: 'journal' },
  note: { label: 'ملاحظات وكيل', icon: FileText, view: 'memory' },
}

const OPEN_EVENT = 'wakil:open-search'

/** Open the palette from anywhere (the pill/headers call this). */
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

export function CommandPalette() {
  const businessId = useWakil((s) => s.businessId)
  const setView = useWakil((s) => s.setView)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  )

  /** Close + clear: every close path goes through here (no effect needed). */
  const close = () => {
    setOpen(false)
    setQuery('')
    setCursor(0)
  }

  // — global shortcuts: ⌘K / Ctrl+K opens, Esc closes.
  useEffect(() => {
    if (!mounted) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') {
        setOpen(false)
        setQuery('')
        setCursor(0)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [mounted])

  // Reset the query when the palette CLOSES, and focus the input when it opens.
  // (State updates are driven from the event handlers, not from an effect, so
  // the React Compiler's set-state-in-effect rule stays satisfied.)
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(t)
  }, [open])

  // Arabic typing is fast; debounce so we issue ~3 queries/second at most.
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 180)
    return () => window.clearTimeout(t)
  }, [query])

  const enabled = open && !!businessId && debounced.length >= 2
  const { data, isFetching } = useQuery({
    queryKey: ['search', businessId, debounced],
    queryFn: () => api.search(businessId!, debounced),
    enabled,
    staleTime: 20_000,
  })

  const results = useMemo(() => data?.results ?? [], [data])
  const grouped = useMemo(() => {
    const map = new Map<SearchHitDTO['kind'], SearchHitDTO[]>()
    for (const r of results) {
      const list = map.get(r.kind) ?? []
      list.push(r)
      map.set(r.kind, list)
    }
    return [...map.entries()]
  }, [results])

  const flat = useMemo(() => grouped.flatMap(([, list]) => list), [grouped])

  const choose = (hit: SearchHitDTO) => {
    setView(KIND_META[hit.kind].view)
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(flat.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = flat[cursor]
      if (hit) choose(hit)
    }
  }

  if (!mounted || !open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="البحث السريع"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="glass-strong w-full max-w-xl overflow-hidden rounded-2xl border shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border/60 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="دوّر على صنف، عميل، عملية، أو ملاحظة…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="نص البحث"
            aria-autocomplete="list"
            aria-controls={listId}
            dir="auto"
            autoComplete="off"
          />
          <button
            type="button"
            onClick={close}
            className="icon-seat size-8 text-muted-foreground hover:text-foreground"
            aria-label="اقفل البحث"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div id={listId} role="listbox" className="max-h-[52vh] overflow-y-auto scroll-warm p-2">
          {!enabled ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              اكتب حرفين على الأقل للبحث في كل حاجة.
            </p>
          ) : isFetching && results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">بندوّر…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              مفيش نتائج لـ«{debounced}» — جرّب كلمة تانية.
            </p>
          ) : (
            grouped.map(([kind, list]) => {
              const meta = KIND_META[kind]
              const Icon = meta.icon
              return (
                <div key={kind} className="mb-1">
                  <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {meta.label} ({arNum(list.length)})
                  </p>
                  {list.map((hit) => {
                    const index = flat.indexOf(hit)
                    const active = index === cursor
                    return (
                      <button
                        key={`${hit.kind}-${hit.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => choose(hit)}
                        style={{ ['--stagger' as string]: Math.min(index, 8) }}
                        className={cn(
                          'tap enter-rise flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start',
                          active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
                        )}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" dir="auto">
                            {hit.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground" dir="auto">
                            {hit.subtitle}
                          </span>
                        </span>
                        {hit.ref ? (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {hit.ref}
                          </span>
                        ) : null}
                        {active ? (
                          <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
          <span>↑ ↓ للتنقل · Enter للفتح</span>
          <span className="num">⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>
  )
}
