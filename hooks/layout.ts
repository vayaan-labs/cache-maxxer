import { fmtClock, fmtTokens, fmtUsd } from './format'
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
    segs.push(
      { id: 'clock', group: 1, line: 1, rank: null, runs: [{ text: 'expired', tone: 'muted', bold: true }] },
      {
        id: 'rewrite',
        group: 1,
        line: 1,
        rank: null,
        runs: [muted(` · next message re-writes ${what}${cost === null ? '' : ` (~${fmtUsd(cost)})`}`)],
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
    segs.push({ id: 'saved', group: 5, line: 2, rank: 2, runs: [muted('saved '), fg(`~${fmtUsd(v.totals.savingsUsd)}`)] })
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

// Chooses what the band shows in the room it has. Terminal text always takes one line; where a
// second line is allowed it is used only when everything cannot fit on the first. Pieces then drop
// in rank order (sparkline, savings, totals, keep-warm note, track, context, session hit rate)
// until each line fits. The countdown and the last request's hit rate never drop.
export function planLines(
  segs: readonly Seg[],
  widthOf: (s: Seg) => number,
  sepWidth: number,
  room: number,
  allowSecondLine: boolean,
): Seg[][] {
  const lineWidth = (l: readonly Seg[]) => l.reduce((n, s) => n + widthOf(s), 0) + groupChanges(l) * sepWidth
  if (!allowSecondLine || lineWidth(segs) <= room) {
    return [dropUntilFit([[...segs]], lineWidth, room)[0]!]
  }
  const lines = [segs.filter(s => s.line === 1), segs.filter(s => s.line === 2)]
  return dropUntilFit(lines, lineWidth, room).filter(l => l.length > 0)
}

function dropUntilFit(lines: Seg[][], lineWidth: (l: readonly Seg[]) => number, room: number): Seg[][] {
  for (;;) {
    if (lines.every(l => lineWidth(l) <= room)) return lines
    let victim: Seg | null = null
    for (const l of lines) {
      for (const s of l) if (s.rank !== null && (victim === null || s.rank < victim.rank!)) victim = s
    }
    if (victim === null) return lines
    const gone = victim
    lines = lines.map(l => l.filter(s => s !== gone))
  }
}

export const runsText = (runs: readonly Run[]) => runs.map(r => r.text).join('')
