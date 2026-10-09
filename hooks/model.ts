import type { TurnUsage } from 'claude-code'

import type { BreakInfo, CacheSettings, CacheState, Pings, Req, Totals } from '../types'
import { fmtIdle } from './format'
import { savingsUsd, writeCostUsd } from './pricing'

export const EMPTY_CACHE: CacheState = { startedAt: 0, ttlMs: null, model: '', ctx: 0, cached: 0 }
export const EMPTY_TOTALS: Totals = {
  requests: 0,
  read: 0,
  written: 0,
  uncached: 0,
  savingsUsd: 0,
  writeCostUsd: 0,
  isPriced: false,
}

export const EMPTY_PINGS: Pings = { count: 0, read: 0, rebuilds: 0, costUsd: 0, isPriced: false }
export const DEFAULT_SETTINGS: CacheSettings = { keepWarm: false, lead: 'auto', idleCap: '3h' }

export const HISTORY_LIMIT = 48
export const BREAKS_KEPT = 20
const BREAK_MIN_WRITE = 20_000

// What happened to the conversation since its last request that can explain a rebuild.
export type Pending = { kind: 'cleared' } | { kind: 'compacted' } | { kind: 'idle'; idleMs: number } | null

// The cached prefix is lost when a request writes a lot and reads less than half of what the
// previous request cached. Nothing was lost when that total is 0 (no earlier request), or when a big
// new message is written on top of a prefix that was read.
export const isBreak = (written: number, read: number, previouslyCached: number): boolean =>
  written > BREAK_MIN_WRITE && read < previouslyCached / 2

export function inferCause(a: {
  gapMs: number | null
  ttlMs: number
  prevModel: string
  model: string
  pending: Pending
}): string {
  if (a.gapMs !== null && a.gapMs > a.ttlMs) return `expired after ${fmtIdle(a.gapMs)} idle`
  if (a.pending?.kind === 'idle') return `expired after ${fmtIdle(a.pending.idleMs)} idle`
  if (a.prevModel && a.model && a.prevModel !== a.model) return 'model switched'
  if (a.pending?.kind === 'compacted') return 'compacted'
  if (a.pending?.kind === 'cleared') return 'cleared'
  return 'prefix changed (system prompt, tools or MCP servers)'
}

export type Snapshot = {
  cache: CacheState
  history: readonly Req[]
  totals: Totals
  breaks: readonly BreakInfo[]
}

// Folds one main-conversation request into what the band reads. The request's own start
// restarts the entry's life when it read or wrote the cache.
export function applyRequest(
  s: Snapshot,
  r: { startedAt: number; usage: TurnUsage; ttlMs: number },
  pending: Pending,
): { next: Snapshot; brk: BreakInfo | null } {
  const { usage } = r
  const tokens = {
    read: usage.cache_read_input_tokens,
    written: usage.cache_creation_input_tokens,
    uncached: usage.input_tokens,
    output: usage.output_tokens,
  }
  const totalInput = tokens.read + tokens.written + tokens.uncached

  let brk: BreakInfo | null = null
  if (isBreak(tokens.written, tokens.read, s.cache.cached)) {
    brk = {
      at: r.startedAt,
      written: tokens.written,
      costUsd: writeCostUsd(usage.model, tokens.written, r.ttlMs, totalInput),
      cause: inferCause({
        gapMs: s.cache.startedAt > 0 ? r.startedAt - s.cache.startedAt : null,
        ttlMs: r.ttlMs,
        prevModel: s.cache.model,
        model: usage.model,
        pending,
      }),
    }
  }

  const touched = tokens.read > 0 || tokens.written > 0
  const cache: CacheState = {
    startedAt: touched && r.startedAt > s.cache.startedAt ? r.startedAt : s.cache.startedAt,
    ttlMs: s.cache.ttlMs,
    model: usage.model,
    ctx: totalInput + tokens.output,
    cached: tokens.read + tokens.written,
  }
  const saved = savingsUsd(usage.model, tokens, r.ttlMs)
  const cost = writeCostUsd(usage.model, tokens.written, r.ttlMs, totalInput)
  const t = s.totals
  const totals: Totals = {
    requests: t.requests + 1,
    read: t.read + tokens.read,
    written: t.written + tokens.written,
    uncached: t.uncached + tokens.uncached,
    savingsUsd: t.savingsUsd + (saved ?? 0),
    writeCostUsd: t.writeCostUsd + (cost ?? 0),
    isPriced: t.isPriced || saved !== null,
  }
  const req: Req = { read: tokens.read, written: tokens.written, uncached: tokens.uncached, isBreak: brk !== null }
  return {
    next: {
      cache,
      history: [...s.history, req].slice(-HISTORY_LIMIT),
      totals,
      breaks: brk ? [...s.breaks, brk].slice(-BREAKS_KEPT) : s.breaks,
    },
    brk,
  }
}
