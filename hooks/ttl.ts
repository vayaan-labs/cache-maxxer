const HOUR_MS = 3_600_000
const FIVE_MIN_MS = 300_000

// How long a cache entry lives, and whether that is known or assumed.
export type TtlInfo = { ms: number; isKnown: boolean }

// The setting wins; on auto, what the transcript showed; until then an hour is assumed.
export function ttlInfo(setting: string, learnedMs: number | null): TtlInfo {
  if (setting === '1h') return { ms: HOUR_MS, isKnown: true }
  if (setting === '5m') return { ms: FIVE_MIN_MS, isKnown: true }
  return learnedMs === null ? { ms: HOUR_MS, isKnown: false } : { ms: learnedMs, isKnown: true }
}

type Split = { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown }

const count = (n: unknown) => (typeof n === 'number' && n > 0 ? n : 0)

// Reads the newest cache write's split out of the tail of a session transcript: the entry lives as
// long as the larger part of what the request wrote. Null when no line shows a write.
export function parseTtl(tail: string): number | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('cache_creation')) continue
    try {
      const entry = JSON.parse(line) as { message?: { usage?: { cache_creation?: Split } }; usage?: { cache_creation?: Split } }
      const split = entry.message?.usage?.cache_creation ?? entry.usage?.cache_creation
      if (!split) continue
      const h = count(split.ephemeral_1h_input_tokens)
      const m = count(split.ephemeral_5m_input_tokens)
      if (h + m === 0) continue
      return m > h ? FIVE_MIN_MS : HOUR_MS
    } catch {
      // A line cut by the start of the tail, or one that is not a request
    }
  }
  return null
}

const LEADS: Record<string, number> = { '1m': 60_000, '2m': 120_000, '4m': 240_000, '8m': 480_000 }

// How long before expiry keep warm acts (and the warning shows): 4 minutes of an hour, 40 seconds
// of five minutes, and never more than half the entry's life.
export function leadMs(setting: string, ttlMs: number): number {
  const auto = ttlMs >= 600_000 ? 240_000 : 40_000
  return Math.min(LEADS[setting] ?? auto, ttlMs / 2)
}

export const leadLabel = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`)

const CAPS: Record<string, number> = { '1h': 3_600_000, '3h': 10_800_000, '8h': 28_800_000 }

// How long the person may be idle before keep warm stops; null is no cap.
export const idleCapMs = (setting: string): number | null => CAPS[setting] ?? null
