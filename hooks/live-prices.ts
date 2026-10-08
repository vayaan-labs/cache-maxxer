// The price table from Anthropic's own pricing page, read when Claude Code starts and at most once a
// day, so a new model or a changed price shows up without a new release of this plugin. What it
// returns replaces the built-in table in pricing.ts; when the page cannot be read or does not parse,
// the last good copy (or the built-in table) stays.

import type { Price, PriceEntry } from './pricing'

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
export const REFRESH_MS = 24 * 60 * 60_000

// The money in a cell such as "$0.20 / MTok<sup>2</sup>".
const dollars = (cell: string): number | null => {
  const m = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok/i.exec(cell)
  return m ? Number(m[1]) : null
}

// "Claude Opus 5.5" is `claude-opus-5-5`; a model older than 4 puts its version first, as
// "Claude Haiku 3.5" is `claude-3-5-haiku`. A note after the name is not part of it, including one
// holding a link, as in "Claude Opus 4 ([retired](https://...))": the link goes first, whole.
export const idOf = (name: string): string | null => {
  const plain = name.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').trim()
  const m = /^Claude\s+([A-Za-z]+)\s+([0-9]+(?:\.[0-9]+)?)$/.exec(plain.replace(/\s+/g, ' '))
  if (!m) return null
  const family = m[1].toLowerCase()
  const version = m[2].replace('.', '-')
  return Number(m[2].split('.')[0]) < 4 ? `claude-${version}-${family}` : `claude-${family}-${version}`
}

// The tier a row names, for a model priced by prompt length: "(for prompts up to 100,000 tokens)"
// or "(for prompts over 100,000 tokens)".
const tierOf = (name: string): { kind: 'upTo' | 'over'; tokens: number } | null => {
  const m = /for prompts (up to|over) ([0-9][0-9,]*) tokens/i.exec(name)
  return m ? { kind: m[1].toLowerCase() === 'over' ? 'over' : 'upTo', tokens: Number(m[2].replace(/,/g, '')) } : null
}

const isPrice = (p: unknown): p is Price =>
  typeof p === 'object' && p !== null &&
  (['input', 'write5m', 'write1h', 'read', 'output'] as const).every(k => {
    const v = (p as Record<string, unknown>)[k]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
  })

// A table kept from an earlier read is used only if it has the shape parsePricing makes, so one saved
// by another version, or damaged, can never break pricing.
export const isPriceTable = (entries: unknown): entries is PriceEntry[] =>
  Array.isArray(entries) && entries.length > 0 &&
  entries.every(e => {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') return false
    const p = e[1] as Record<string, unknown> | null
    if (typeof p === 'object' && p !== null && 'upTo' in p) {
      return typeof p.upTo === 'number' && p.upTo > 0 && isPrice(p.small) && isPrice(p.large)
    }
    return isPrice(p)
  })

// Reads the "Model pricing" table: one row per model with base input, 5 minute write, 1 hour write,
// cache read and output. Null unless every row it keeps is whole and the table holds at least three
// models, so a page that changed its shape never replaces a good table with a broken one.
export function parsePricing(markdown: string): PriceEntry[] | null {
  const start = markdown.search(/^##\s+Model pricing\s*$/m)
  if (start < 0) return null
  const section = markdown.slice(start).split(/^##\s/m)[1] ?? ''
  const rows = section.split('\n').filter(line => line.trim().startsWith('|'))
  const header = rows[0]?.split('|').map(c => c.trim().toLowerCase()) ?? []
  const wanted = ['base input', '5m cache write', '1h cache write', 'cache hit', 'output']
  const columns = wanted.map(w => header.findIndex(h => h.startsWith(w)))
  if (columns.some(c => c < 0)) return null

  const flat = new Map<string, Price>()
  const tiers = new Map<string, { upTo?: { tokens: number; price: Price }; over?: Price }>()
  for (const row of rows.slice(2)) {
    const cells = row.split('|').map(c => c.trim())
    const name = cells[1] ?? ''
    const id = idOf(name)
    // A model row this cannot name would drop that model's price without a word, so it doubts the page.
    if (!id) {
      if (/^claude\b/i.test(name)) return null
      continue
    }
    const [input, write5m, write1h, read, output] = columns.map(c => dollars(cells[c] ?? ''))
    if ([input, write5m, write1h, read, output].some(v => v === null || !Number.isFinite(v) || v < 0)) return null
    const price: Price = { input: input!, write5m: write5m!, write1h: write1h!, read: read!, output: output! }
    if (price.read > price.input) return null
    const tier = tierOf(name)
    if (!tier) {
      if (!flat.has(id)) flat.set(id, price)
      continue
    }
    const t = tiers.get(id) ?? {}
    if (tier.kind === 'upTo') t.upTo = { tokens: tier.tokens, price }
    else t.over = price
    tiers.set(id, t)
  }

  const entries: PriceEntry[] = [...flat.entries()]
  for (const [id, t] of tiers) {
    if (!t.upTo || !t.over) return null
    entries.push([id, { upTo: t.upTo.tokens, small: t.upTo.price, large: t.over }])
  }
  if (entries.length < 3) return null
  // A longer id stands before any id it begins with, so `claude-opus-4-5` is matched before `claude-opus-4`.
  return entries.sort((a, b) => b[0].length - a[0].length)
}
