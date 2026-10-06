import type { BreakInfo, CacheSettings, CacheState, Pings, Req, Totals } from '../types'
import { fmtClock, fmtTokens, fmtUsd, pct } from './format'
import { writeCostUsd } from './pricing'
import { ttlInfo, type TtlInfo } from './ttl'

// Everything the band and the pane draw, read once per redraw.
export type View = {
  cache: CacheState
  ttl: TtlInfo
  leftMs: number
  isExpired: boolean
  history: readonly Req[]
  totals: Totals
  breaks: readonly BreakInfo[]
  settings: CacheSettings
  pings: Pings
  paused: string
}

export type Tone = 'fg' | 'muted' | 'warm' | 'warn' | 'danger' | 'accent'

export function makeView(a: {
  now: number
  ttlSetting: string
  cache: CacheState
  history: readonly Req[]
  totals: Totals
  breaks: readonly BreakInfo[]
  settings: CacheSettings
  pings: Pings
  paused: string
}): View {
  const ttl = ttlInfo(a.ttlSetting, a.cache.ttlMs)
  const { now, ...rest } = a
  const leftMs = a.cache.startedAt + ttl.ms - now
  return { ...rest, ttl, leftMs, isExpired: leftMs <= 0 }
}

// Green while warm, amber in the last sixth of the entry's life, red in the last thirtieth, grey once expired.
export function stateTone(v: View): Tone {
  if (v.isExpired) return 'muted'
  if (v.leftMs <= v.ttl.ms / 30) return 'danger'
  if (v.leftMs <= v.ttl.ms / 6) return 'warn'
  return 'warm'
}

export const stateWord = (v: View): string =>
  v.isExpired ? 'Expired' : v.leftMs <= v.ttl.ms / 6 ? 'Expiring soon' : 'Warm'

export const hitRate = (r: { read: number; written: number; uncached: number }): number =>
  pct(r.read, r.read + r.written + r.uncached)

export const lastRequest = (v: View): Req | null => v.history[v.history.length - 1] ?? null

export const sessionHitRate = (v: View): number => hitRate(v.totals)

// What the next message re-writes once the entry has expired, and what that write costs.
export function rewriteCost(v: View): number | null {
  return v.cache.ctx > 0 ? writeCostUsd(v.cache.model, v.cache.ctx, v.ttl.ms) : null
}

// What the person sees of how long an entry lives: the length, or the assumed hour.
export const ttlLabel = (v: View): string =>
  v.ttl.ms >= 600_000 ? (v.ttl.isKnown ? '1 hour cache' : '1 hour (assumed)') : '5 minute cache'

// The same, short: the length alone, for the pane's first line when the room is tight.
export const ttlShort = (v: View): string => (v.ttl.ms >= 600_000 ? (v.ttl.isKnown ? '1h' : '1h?') : '5m')

// The pings so far, in the pane, piece by piece. A ping that rebuilt a lapsed cache is told apart
// from one that kept it warm.
export function pingsItems(p: Pings): string[] {
  if (p.count === 0 && p.rebuilds === 0) return ['No pings yet.']
  const parts = [p.count > 0 ? `${p.count} ping${p.count === 1 ? '' : 's'} so far` : 'No ping has kept it warm yet']
  if (p.count > 0) parts.push(`${fmtTokens(p.read)} tokens read`)
  if (p.rebuilds > 0) parts.push(`${p.rebuilds} rebuilt a lapsed cache`)
  if (p.isPriced) parts.push(`~${fmtUsd(p.costUsd)}`)
  return parts
}

// What /cache says where nothing draws (a -p run).
export function summaryText(v: View): string {
  const keep = `Keep warm is ${v.settings.keepWarm ? 'on' : 'off'}.`
  if (v.cache.startedAt === 0) return `Cache Maxxer: no cache yet. ${keep}`
  const state = v.isExpired ? 'expired' : `${stateWord(v).toLowerCase()}, ${fmtClock(v.leftMs, v.ttl.ms)} left`
  const hit = v.totals.requests > 0 ? ` ${sessionHitRate(v)}% hit rate over ${v.totals.requests} requests.` : ''
  return `Cache Maxxer: ${ttlLabel(v)}, ${state}.${hit} ${keep}`
}
