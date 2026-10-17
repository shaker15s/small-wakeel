'use client'

// وكيل — ResultCards: renders the structured results the agent returns
// (tables / key-value / plain text). All digit-runs are wrapped in .num spans
// so money & quantities stay LTR inside the RTL layout.

import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { BookOpen, ExternalLink, FileText, Info, Table as TableIcon } from 'lucide-react'

import { Card, CardContent, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { sfx } from '@/lib/sound-effects'
import { cn } from '@/lib/utils'
import type { ResultCardDTO, SourceDTO } from '@/lib/types'

/** Wrap every digit-run in a .num span so numbers stay LTR inside RTL text. */
function withNums(text: string): React.ReactNode {
  if (!text) return text
  const parts = text.split(
    /([\u0660-\u0669\u066B\u066C\u06F0-\u06F9][\u0660-\u0669\u066B\u066C\u06F0-\u06F9.,]*|\d[\d.,]*)/g,
  )
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    i % 2 === 1 && p ? <span key={i} className="num">{p}</span> : p,
  )
}

export function ResultCards({ cards }: { cards: ResultCardDTO[] }) {
  useEffect(() => {
    if (cards.length > 0) {
      sfx.playCardReveal(0)
    }
  }, [cards.length])

  if (!cards.length) return null

  return (
    <div className="flex w-full flex-col gap-3">
      {cards.map((card, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 18, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          whileHover={{ y: -2 }}
          transition={{
            type: 'spring',
            stiffness: 380,
            damping: 26,
            delay: i * 0.065,
          }}
          className="w-full"
        >
          {card.kind === 'table' ? (
            <TableCard card={card} />
          ) : card.kind === 'kv' ? (
            <KvCard card={card} />
          ) : card.kind === 'sources' ? (
            <SourcesCard card={card} />
          ) : (
            <TextCard card={card} />
          )}
        </motion.div>
      ))}
    </div>
  )
}

function CardTitleRow({ icon: Icon, title }: { icon: typeof Info; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4">
      <Icon className="size-4 shrink-0 text-[var(--wakil-amber)]" aria-hidden="true" />
      <CardTitle className="text-sm leading-6">{title}</CardTitle>
    </div>
  )
}

// ---------------------------------------------------------------------------

type TableCardDTO = Extract<ResultCardDTO, { kind: 'table' }>

function TableCard({ card }: { card: TableCardDTO }) {
  const cols = card.columns

  if (!cols.length) return null

  /** money/qty columns read better end-aligned; last column aligns end by default */
  const isEnd = (idx: number) => cols[idx].align === 'end' || (cols[idx].align == null && idx === cols.length - 1)

  return (
    <Card className="w-full gap-2 py-3">
      <CardTitleRow icon={TableIcon} title={card.title} />

      <div className="scroll-warm max-h-72 overflow-y-auto px-2">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((col, idx) => (
                <TableHead
                  key={col.key}
                  className={cn('h-9 text-xs', isEnd(idx) ? 'text-end' : 'text-start')}
                >
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>

          <TableBody>
            {card.rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={cols.length}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  مفيش نتايج
                </TableCell>
              </TableRow>
            ) : (
              card.rows.map((row, ri) => (
                <TableRow key={ri}>
                  {cols.map((col, idx) => (
                    <TableCell
                      key={col.key}
                      className={cn('py-2 text-sm', isEnd(idx) ? 'text-end' : 'text-start')}
                    >
                      {withNums(String(row[col.key] ?? '—'))}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>

          {card.footer && card.footer.length > 0 && (
            <TableFooter>
              {card.footer.map((f, fi) => (
                <TableRow key={fi}>
                  {cols.length > 1 ? (
                    <TableCell colSpan={cols.length - 1} className="py-2 text-start text-sm font-semibold">
                      {f.label}
                    </TableCell>
                  ) : null}
                  <TableCell
                    colSpan={cols.length > 1 ? 1 : cols.length}
                    className="py-2 text-end text-sm font-semibold"
                  >
                    {cols.length > 1 ? withNums(f.value) : `${f.label}: ${withNums(f.value)}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableFooter>
          )}
        </Table>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------

type KvCardDTO = Extract<ResultCardDTO, { kind: 'kv' }>

function KvCard({ card }: { card: KvCardDTO }) {
  const rawRows = card.rows ?? (card as unknown as { items?: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }[] }).items ?? []
  return (
    <Card className="w-full gap-2 py-3">
      <CardTitleRow icon={Info} title={card.title} />
      <CardContent className="flex flex-col gap-1.5 px-4">
        {rawRows.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">مفيش نتايج</p>
        ) : (
          rawRows.map((row, i) => (
            <div
              key={`${row.label}-${i}`}
              className="flex items-baseline justify-between gap-4 text-sm"
            >
              <span className="text-muted-foreground">{row.label}</span>
              <span
                className={cn(
                  'text-end font-semibold',
                  row.tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
                  row.tone === 'bad' && 'text-rose-600 dark:text-rose-400',
                  row.tone === 'neutral' && 'text-foreground'
                )}
              >
                {withNums(row.value)}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

type TextCardDTO = Extract<ResultCardDTO, { kind: 'text' }>

function TextCard({ card }: { card: TextCardDTO }) {
  return (
    <Card className="w-full gap-2 py-3">
      <CardTitleRow icon={FileText} title={card.title} />
      <CardContent className="px-4">
        <p className="whitespace-pre-wrap text-sm leading-7">{withNums(card.body)}</p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

type SourcesCardDTO = Extract<ResultCardDTO, { kind: 'sources' }>

/** Arabic-Indic ordinal for citation chips [١] [٢] … */
const AR_DIGITS = ['١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩', '١٠']

function sourceOrdinal(i: number): string {
  return AR_DIGITS[i] ?? String(i + 1)
}

/** Cited-sources card for deep-research replies (R15) — numbered [١] [٢] … */
export function SourcesCard({ card }: { card: SourcesCardDTO }) {
  return (
    <Card className="w-full gap-2 py-3">
      <CardTitleRow icon={BookOpen} title={card.title} />
      <CardContent className="flex flex-col gap-1.5 px-4">
        {card.sources.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">مفيش مصادر</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {card.sources.map((s: SourceDTO, i: number) => (
              <li key={`${s.title}-${i}`} className="flex items-start gap-2 text-sm">
                <span
                  className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wakil-amber)]/15 text-xs font-bold text-[var(--wakil-amber)]"
                  aria-label={`مصدر ${sourceOrdinal(i)}`}
                >
                  {sourceOrdinal(i)}
                </span>
                <div className="min-w-0 flex-1">
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-baseline gap-1 font-semibold underline-offset-2 hover:underline"
                    >
                      <span className="truncate">{s.title}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="font-semibold">{s.title}</span>
                  )}
                  {(s.host || s.ref) && (
                    <span className="ms-2 text-xs text-muted-foreground" dir="ltr">
                      {s.ref ? s.ref : s.host}
                    </span>
                  )}
                  {s.snippet && (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {s.snippet}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
