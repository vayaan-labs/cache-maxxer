const trimmed = (n: number) => n.toFixed(1).replace(/\.0$/, '')

// 950, 1.2K, 182K, 3.1M
export function fmtTokens(n: number): string {
  if (n >= 1_000_000 || Math.round(n / 1000) >= 1000) return `${trimmed(n / 1e6)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${trimmed(n / 1000)}K`
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n < 0) return `-${fmtUsd(-n)}`
  if (n >= 100) return `$${Math.round(n)}`
  if (n > 0 && n < 0.01) return '< $0.01'
  return `$${n.toFixed(2)}`
}

// A dollar figure that is an estimate: ~$0.31, < $0.01 for a smaller cost, a loss as -$0.06,
// and a loss too small to show in cents as ~$0.00.
export function fmtApprox(n: number): string {
  if (n < 0) return n > -0.005 ? '~$0.00' : `-$${-n >= 100 ? Math.round(-n) : (-n).toFixed(2)}`
  if (n > 0 && n < 0.01) return '< $0.01'
  return `~${fmtUsd(n)}`
}

// mm:ss, with two-digit minutes for an hour-long entry so the band keeps its width.
export function fmtClock(ms: number, ttlMs: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = String(Math.floor(seconds / 60))
  return `${ttlMs >= 600_000 ? minutes.padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`
}

// 63m, 2h 5m
export function fmtIdle(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 120) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function fmtLocalTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0)

// A share to two decimals, cut rather than rounded, so a rate short of 100% never reads 100.00%.
export const fmtPct = (n: number): string => `${(Math.floor(n * 100 + 1e-9) / 100).toFixed(2)}%`
