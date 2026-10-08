// Dollars per million tokens. The table Anthropic publishes is read when Claude Code starts
// (live-prices.ts), so a new model or a changed price needs no new release of this plugin; until that
// has worked, the table below stands in, copied from the same page
// (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-08). A model in neither
// has no price, and nothing here guesses one.
export type Price = { input: number; write5m: number; write1h: number; read: number; output: number }

// A model priced by prompt length (Claude Haiku 5.5): a prompt of more than `upTo` tokens, cache reads
// and writes included, pays the second price for every token of that request.
export type Tiered = { upTo: number; small: Price; large: Price }

export type PriceEntry = readonly [string, Price | Tiered]

const flat = (input: number, read: number, output: number): Price =>
  ({ input, write5m: input * 1.25, write1h: input * 2, read, output })

// First match wins, so a longer id stands before any id it begins with (`claude-opus-4-5` before
// `claude-opus-4`).
const BUILT_IN: readonly PriceEntry[] = [
  ['claude-fable-5-1', flat(10, 0.25, 50)],
  ['claude-mythos-5-1', flat(10, 0.25, 50)],
  ['claude-fable-5', flat(10, 1, 50)],
  ['claude-mythos-5', flat(10, 1, 50)],
  ['claude-opus-5-5', flat(4, 0.2, 20)],
  ['claude-opus-5', flat(5, 0.5, 25)],
  ['claude-opus-4-8', flat(5, 0.5, 25)],
  ['claude-opus-4-7', flat(5, 0.5, 25)],
  ['claude-opus-4-6', flat(5, 0.5, 25)],
  ['claude-opus-4-5', flat(5, 0.5, 25)],
  ['claude-opus-4-1', flat(15, 1.5, 75)],
  ['claude-opus-4', flat(15, 1.5, 75)],
  ['claude-sonnet-5-5', flat(2, 0.1, 10)],
  ['claude-sonnet-5', flat(2, 0.2, 10)],
  ['claude-sonnet-4-6', flat(3, 0.3, 15)],
  ['claude-sonnet-4-5', flat(3, 0.3, 15)],
  ['claude-sonnet-4', flat(3, 0.3, 15)],
  ['claude-haiku-5-5', { upTo: 100_000, small: flat(0.1, 0.01, 0.5), large: flat(0.5, 0.05, 2.5) }],
  ['claude-haiku-4-5', flat(1, 0.1, 5)],
  ['claude-3-5-haiku', flat(0.8, 0.08, 4)],
]

// The table read from Anthropic's page, once one has been; null until then.
let live: readonly PriceEntry[] | null = null

export const setLivePrices = (entries: readonly PriceEntry[] | null) => {
  live = entries
}

// An id matches the model's name when it is the name, or the name begins with it followed by a dash,
// a dot or a bracket, which covers dated ids and suffixes such as `[1m]`.
const matches = (model: string, id: string) =>
  model === id || (model.startsWith(id) && '-.['.includes(model[id.length]))

const find = (table: readonly PriceEntry[] | null, model: string) =>
  table?.find(([id]) => matches(model, id))?.[1] ?? null

// The price one request pays, given how many tokens its prompt held. The page's table is asked first;
// a model it does not list (or before it has been read) falls back to the built-in table.
const priceOf = (model: string, promptTokens: number): Price | null => {
  const entry = find(live, model) ?? find(BUILT_IN, model)
  if (!entry) return null
  return 'upTo' in entry ? (promptTokens > entry.upTo ? entry.large : entry.small) : entry
}

export const isPriced = (model: string) => priceOf(model, 0) !== null

export type Tokens = {
  read: number
  written: number
  uncached: number
  output: number
}

const promptOf = (t: Tokens) => t.read + t.written + t.uncached

const writePrice = (p: Price, ttlMs: number) => (ttlMs <= 600_000 ? p.write5m : p.write1h)

// What a cache write costs, for a cache entry living ttlMs, in a request whose prompt held
// promptTokens (a re-write of the whole context is its own prompt, so that is the default).
export const writeCostUsd = (model: string, written: number, ttlMs: number, promptTokens = written): number | null => {
  const p = priceOf(model, promptTokens)
  return p ? (written * writePrice(p, ttlMs)) / 1e6 : null
}

// What reading tokens from a warm cache saved over re-writing them: each paid the read price instead
// of the write price, in requests whose prompt held promptTokens.
export const keptWarmUsd = (model: string, read: number, ttlMs: number, promptTokens = read): number | null => {
  const p = priceOf(model, promptTokens)
  return p ? (read * (writePrice(p, ttlMs) - p.read)) / 1e6 : null
}

// What one request cost in all, or null when the model has no price.
export const requestCostUsd = (model: string, t: Tokens, ttlMs: number): number | null => {
  const p = priceOf(model, promptOf(t))
  if (!p) return null
  return (t.uncached * p.input + t.read * p.read + t.written * writePrice(p, ttlMs) + t.output * p.output) / 1e6
}

// What the cache saved on one request: the reads at the plain input price, less what they cost as
// reads, less the premium the writes paid over plain input.
export const savingsUsd = (model: string, t: Tokens, ttlMs: number): number | null => {
  const p = priceOf(model, promptOf(t))
  if (!p) return null
  return (t.read * (p.input - p.read) - t.written * (writePrice(p, ttlMs) - p.input)) / 1e6
}
