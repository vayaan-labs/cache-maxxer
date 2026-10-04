// Dollars per million tokens for the models in use. A model not listed has no price, and nothing
// here guesses one.
type Price = { input: number; write5m: number; write1h: number; read: number; output: number }

const PRICES: readonly (readonly [string, Price])[] = [
  ['claude-opus-5-5', { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }],
  ['claude-sonnet-5-5', { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 }],
  ['claude-haiku-4-5', { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 }],
]

const priceOf = (model: string): Price | null =>
  PRICES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? null

export type Tokens = {
  read: number
  written: number
  uncached: number
  output: number
}

const writePrice = (p: Price, ttlMs: number) => (ttlMs <= 600_000 ? p.write5m : p.write1h)

// What a cache write costs, for a cache entry living ttlMs.
export const writeCostUsd = (model: string, written: number, ttlMs: number): number | null => {
  const p = priceOf(model)
  return p ? (written * writePrice(p, ttlMs)) / 1e6 : null
}

// What one request cost in all, or null when the model has no price.
export const requestCostUsd = (model: string, t: Tokens, ttlMs: number): number | null => {
  const p = priceOf(model)
  if (!p) return null
  return (t.uncached * p.input + t.read * p.read + t.written * writePrice(p, ttlMs) + t.output * p.output) / 1e6
}

// What the cache saved on one request: the reads at the plain input price, less what they cost as
// reads, less the premium the writes paid over plain input.
export const savingsUsd = (model: string, t: Tokens, ttlMs: number): number | null => {
  const p = priceOf(model)
  if (!p) return null
  return (t.read * (p.input - p.read) - t.written * (writePrice(p, ttlMs) - p.input)) / 1e6
}
