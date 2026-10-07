import { fmtApprox, fmtClock, fmtTokens } from './format'
import { lastRequest, hitRate, rewriteCost, sessionHitRate, stateTone, type Tone, type View } from './view'

export type Run = { text: string; tone: Tone; bold?: boolean }

export type Bar = { share: number; isBreak: boolean }

// One piece of the band. Pieces in one group read as one phrase; a thin separator sits between groups.
export type Seg = {
  id: 'dot' | 'label' | 'clock' | 'track' | 'rewrite' | 'hit' | 'session' | 'ctx' | 'totals' | 'saved' | 'note' | 'spark'
  group: number
  // Which of two lines the piece sits on when one line cannot hold the band
  line: 1 | 2
  // The order pieces are dropped in as the room shrinks, lowest first; null never drops
  rank: number | null
  runs?: Run[]
  // Shorter wordings of `runs`, longest first, for a piece wider than the room it has
  alts?: Run[][]
  tone?: Tone
  // The share of the entry's life left, for the track
  frac?: number
  bars?: Bar[]
}

const SPARK_BARS = 24

const fg = (text: string, bold?: boolean): Run => ({ text, tone: 'fg', ...(bold ? { bold } : {}) })
const muted = (text: string): Run => ({ text, tone: 'muted' })

export function buildSegments(v: View): Seg[] {
  const last = lastRequest(v)
  const tone = stateTone(v)
  const segs: Seg[] = [
    { id: 'dot', group: 1, line: 1, rank: null, tone },
    { id: 'label', group: 1, line: 1, rank: null, runs: [muted('Cache ')] },
  ]
  if (v.isExpired) {
    const cost = rewriteCost(v)
    const what = v.cache.ctx > 0 ? `${fmtTokens(v.cache.ctx)} tokens` : 'the whole context'
    const tokens = v.cache.ctx > 0 ? fmtTokens(v.cache.ctx) : 'everything'
    const price = cost === null ? '' : ` (${fmtApprox(cost)})`
    segs.push(
      { id: 'clock', group: 1, line: 1, rank: null, runs: [{ text: 'expired', tone: 'muted', bold: true }] },
      {
        id: 'rewrite',
        group: 1,
        line: 1,
        rank: null,
        runs: [muted(` · next message re-writes ${what}${price}`)],
        alts: [[muted(` · next message re-writes ${tokens}${price}`)], [muted(` · re-writes ${tokens}${price}`)]],
      },
    )
  } else {
    segs.push(
      {
        id: 'clock',
        group: 1,
        line: 1,
        rank: null,
        runs: [{ text: fmtClock(v.leftMs, v.ttl.ms), tone, bold: true }, ...(v.ttl.isKnown ? [] : [muted(' 1h?')])],
      },
      { id: 'track', group: 1, line: 1, rank: 4, tone, frac: Math.min(1, Math.max(0, v.leftMs / v.ttl.ms)) },
    )
  }
  if (last) {
    segs.push(
      { id: 'hit', group: 2, line: 1, rank: null, runs: [fg(`${hitRate(last)}%`, true), muted(' now')] },
      { id: 'session', group: 2, line: 1, rank: 6, runs: [muted(' · '), fg(`${sessionHitRate(v)}%`, true), muted(' session')] },
    )
  }
  if (v.cache.ctx > 0) {
    segs.push({ id: 'ctx', group: 3, line: 2, rank: 5, runs: [fg(fmtTokens(v.cache.ctx)), muted(' ctx')] })
  }
  if (v.totals.requests > 0) {
    segs.push({
      id: 'totals',
      group: 4,
      line: 2,
      rank: 3,
      runs: [fg(fmtTokens(v.totals.read)), muted(' read · '), fg(fmtTokens(v.totals.written)), muted(' written')],
    })
  }
  if (v.totals.isPriced && v.totals.savingsUsd > 0) {
    segs.push({ id: 'saved', group: 5, line: 2, rank: 2, runs: [muted('saved '), fg(fmtApprox(v.totals.savingsUsd))] })
  }
  const note = keepWarmNote(v)
  if (note) segs.push({ id: 'note', group: 6, line: 2, rank: 3.5, runs: [muted(note)] })
  if (v.history.length > 0) {
    segs.push({
      id: 'spark',
      group: 7,
      line: 1,
      rank: 1,
      bars: v.history.slice(-SPARK_BARS).map(r => ({
        share: r.read / Math.max(1, r.read + r.written + r.uncached),
        isBreak: r.isBreak,
      })),
    })
  }
  return segs
}

// Pings that found the cache already gone are counted apart: they rebuilt it rather than kept it warm.
function keepWarmNote(v: View): string | null {
  if (!v.settings.keepWarm) return null
  if (v.paused) return `keep warm paused (idle ${v.paused})`
  const parts: string[] = []
  if (v.pings.count > 0) parts.push(`kept warm ×${v.pings.count}`)
  if (v.pings.rebuilds > 0) parts.push(`rebuilt ×${v.pings.rebuilds}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

const groupChanges = (line: readonly Seg[]) => line.reduce((n, s, i) => n + (i > 0 && line[i - 1]!.group !== s.group ? 1 : 0), 0)

// The most lines the band takes before it starts leaving pieces out.
export const MAX_BAND_LINES = 5

// Chooses what the band shows in the room it has, in this order. Everything on one line where it fits.
// Otherwise two lines, the countdown and hit rates above the context, totals and notes. Otherwise the
// pieces flow onto as many lines as they need, a group (countdown, hit rates) kept whole where it fits
// a line, and a piece wider than a line takes a shorter wording. Only when that needs more than
// MAX_BAND_LINES lines do pieces drop, in rank order (sparkline, savings, totals, keep-warm note,
// track, context, session hit rate). The countdown and the last request's hit rate never drop.
export function planLines(
  segs: readonly Seg[],
  widthOf: (s: Seg) => number,
  sepWidth: number,
  room: number,
  maxLines: number,
): Seg[][] {
  const lineWidth = (l: readonly Seg[]) => l.reduce((n, s) => n + widthOf(s), 0) + groupChanges(l) * sepWidth
  if (lineWidth(segs) <= room) return [[...segs]]
  const fixed = [segs.filter(s => s.line === 1), segs.filter(s => s.line === 2)].filter(l => l.length > 0)
  if (maxLines >= 2 && fixed.length === 2 && fixed.every(l => lineWidth(l) <= room)) return fixed

  let kept = [...segs]
  for (;;) {
    const lines = flowSegs(kept, widthOf, sepWidth, room)
    if (lines.length <= maxLines) return lines
    let victim: Seg | null = null
    for (const s of kept) if (s.rank !== null && (victim === null || s.rank < victim.rank!)) victim = s
    if (victim === null) return lines
    const gone = victim
    kept = kept.filter(s => s !== gone)
  }
}

// What a piece says once it starts a line: the separator that joined it to the one before goes.
const withoutLead = (s: Seg): Seg => {
  const first = s.runs?.[0]
  if (!first || !first.text.startsWith(' · ')) return s
  return { ...s, runs: [{ ...first, text: first.text.slice(3) }, ...s.runs!.slice(1)] }
}

function flowSegs(segs: readonly Seg[], widthOf: (s: Seg) => number, sepWidth: number, room: number): Seg[][] {
  const lineWidth = (l: readonly Seg[]) => l.reduce((n, s) => n + widthOf(s), 0) + groupChanges(l) * sepWidth
  // A piece wider than a whole line takes the longest wording that fits one.
  const fitted = segs.map(s => {
    if (!s.alts || widthOf(withoutLead(s)) <= room) return s
    const alt = s.alts.map(runs => ({ ...s, runs })).find(a => widthOf(withoutLead(a)) <= room)
    return alt ?? { ...s, runs: s.alts[s.alts.length - 1]! }
  })
  const groups: Seg[][] = []
  for (const s of fitted) {
    const g = groups[groups.length - 1]
    if (g && g[0]!.group === s.group) g.push(s)
    else groups.push([s])
  }
  // A group stays whole where it fits a line; one that does not is split into its pieces.
  const units = groups.flatMap(g => (lineWidth(g) <= room ? [g] : g.map(s => [s])))
  const lines: Seg[][] = []
  let cur: Seg[] = []
  for (const unit of units) {
    if (cur.length > 0 && lineWidth([...cur, ...unit]) > room) {
      lines.push(cur)
      cur = []
    }
    cur.push(...unit)
  }
  if (cur.length > 0) lines.push(cur)
  return lines.map((l, i) => (i === 0 ? l : l.map((s, k) => (k === 0 ? withoutLead(s) : s))))
}

export const runsText = (runs: readonly Run[]) => runs.map(r => r.text).join('')

// Items placed left to right with `gap` columns between them, onto a new row when the next one would
// pass `room`. An item wider than a row takes a row of its own.
export function flowRows<T>(items: readonly T[], widthOf: (item: T) => number, gap: number, room: number): T[][] {
  const rows: T[][] = []
  let used = 0
  for (const item of items) {
    const w = widthOf(item)
    const row = rows[rows.length - 1]
    if (row && used + gap + w <= room) {
      row.push(item)
      used += gap + w
    } else {
      rows.push([item])
      used = w
    }
  }
  return rows
}

// Text cut at spaces into lines of at most `room` columns (a word longer than a line takes its own).
export function wrapWords(text: string, room: number): string[] {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && last.length + 1 + word.length <= room) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}
