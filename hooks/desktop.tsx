import type { ElementTable } from 'claude-code'

import { currentOf, FULL_NAMES, mainButtons, OPTIONS, textPx, type Actions, type ButtonSpec } from './band'
import { fmtApprox, fmtClock, fmtLocalTime, fmtPct, fmtTokens } from './format'
import { wrapWords } from './layout'
import { hitRate, lastRequest, pingsItems, rewriteCost, sessionHitRate, stateTone, stateWord, ttlLabel, type Tone, type View } from './view'

// The Desktop app's band. The same pieces as the terminal's, drawn the way a window can: the
// countdown as a large light numeral over a track that drains, the two hit rates beside it with a
// ring each, the session's numbers as tiles, the last requests as a row of marks, and the keep-warm
// choices as the app's own menus. The first line stays at the bottom, by the input box; what opens,
// opens above it.

type Desktop = ElementTable<'desktop'>

// The drawings are images, so they cannot name the app's theme: they carry a light and a dark
// palette of their own and follow the system's appearance.
const STYLE =
  '<style>' +
  'svg{--fg:#1d1d1f;--muted:#6e6e73;--faint:rgba(0,0,0,.09);--warm:#2f9e6a;--warn:#c47a14;--danger:#d93f3f;--accent:#c96442}' +
  '@media (prefers-color-scheme:dark){svg{--fg:#f2f2f2;--muted:#9b9ba1;--faint:rgba(255,255,255,.13);--warm:#4cc98f;--warn:#f0a73a;--danger:#ff6b6b;--accent:#e08a6c}}' +
  'text{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums;fill:var(--fg)}' +
  '.label{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:9px;letter-spacing:.14em;fill:var(--muted)}' +
  '.muted{fill:var(--muted)}' +
  '</style>'

const TONE_VAR: Record<Tone, string> = {
  fg: 'var(--fg)',
  muted: 'var(--muted)',
  warm: 'var(--warm)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  accent: 'var(--accent)',
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${STYLE}${body}</svg>`

// Pixels a run of text takes at a size, by the same estimate the drawings are laid out with, with
// room to spare: a drawing's text cannot reflow, so too wide is safe and too narrow cuts it off.
const px = (text: string, size: number, bold = false) => textPx(text, bold) * (size / 12) * 1.15

// The ink a spaced label actually takes: the monospace advance is 0.6 of the size, plus the spacing
// between characters. The first line spaces its blocks by this, so it is the real width, not padded.
const labelInk = (text: string) => text.length * 9 * 0.6 + Math.max(0, text.length - 1) * 9 * 0.14

// Each character's advance in the drawings' type, measured from the font itself at every size and
// weight the drawings use, in the order of ADVANCE_CHARS; a drawing's text cannot reflow, so its
// width comes from these rather than an estimate.
const ADVANCE_CHARS = "0123456789 !\"#$%&'()*+,-./:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~·…"
const ADVANCES: Record<string, number[]> = {
  '12/400': [7.56, 7.56, 7.56, 7.56, 7.56, 7.56, 7.56, 7.56, 7.56, 7.56, 3.38, 3.73, 5.73, 7.56, 7.56, 11.11, 8.48, 3.56, 4.58, 4.58, 5.66, 7.09, 3.56, 5.19, 3.56, 3.66, 3.56, 3.56, 7.2, 6.73, 7.2, 6.16, 11.02, 7.97, 7.89, 8.47, 8.59, 7.14, 6.86, 8.84, 8.91, 3.2, 6.45, 7.91, 6.81, 10.48, 8.91, 9.02, 7.62, 9.02, 7.84, 7.64, 6.2, 8.84, 7.73, 11.27, 8.14, 7.05, 7.94, 4.58, 4.58, 7, 6.62, 7.08, 6.42, 7.08, 6.33, 4.58, 7.02, 7.06, 2.97, 2.95, 6.52, 3.03, 10.44, 7, 6.5, 7.03, 7.02, 4.56, 6.05, 4.36, 7, 6.5, 9.3, 6.3, 6.52, 6.47, 7.56, 3.2, 9.66],
  '12/500': [7.73, 7.73, 7.73, 7.73, 7.73, 7.73, 7.73, 7.73, 7.73, 7.73, 3.28, 3.92, 6.09, 7.73, 7.73, 11.55, 8.55, 3.78, 4.78, 4.78, 5.72, 7.27, 3.78, 5.25, 3.78, 3.78, 3.78, 3.78, 7.39, 6.95, 7.39, 6.33, 10.98, 8.19, 8.02, 8.58, 8.69, 7.27, 6.97, 8.91, 9.08, 3.42, 6.69, 8.08, 6.92, 10.62, 9.02, 9.09, 7.78, 9.09, 8.02, 7.81, 6.55, 8.89, 7.97, 11.47, 8.36, 7.2, 8, 4.78, 4.78, 7.19, 6.75, 7.22, 6.48, 7.22, 6.42, 4.77, 7.16, 7.25, 3.12, 3.12, 6.75, 3.22, 10.69, 7.19, 6.59, 7.17, 7.16, 4.8, 6.17, 4.56, 7.19, 6.67, 9.59, 6.52, 6.73, 6.59, 7.73, 3.36, 10.27],
  '13/500': [8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 3.48, 4.17, 6.53, 8.3, 8.3, 12.44, 9.17, 4.02, 5.09, 5.09, 6.11, 7.78, 4.02, 5.61, 4.02, 4.02, 4.02, 4.02, 7.92, 7.45, 7.92, 6.78, 11.81, 8.8, 8.61, 9.22, 9.33, 7.78, 7.47, 9.56, 9.75, 3.62, 7.16, 8.67, 7.42, 11.42, 9.69, 9.77, 8.34, 9.77, 8.59, 8.38, 7.02, 9.55, 8.55, 12.34, 8.97, 7.72, 8.59, 5.09, 5.09, 7.7, 7.23, 7.73, 6.94, 7.73, 6.88, 5.08, 7.67, 7.77, 3.31, 3.31, 7.23, 3.41, 11.5, 7.7, 7.06, 7.69, 7.67, 5.11, 6.59, 4.86, 7.7, 7.16, 10.31, 6.98, 7.22, 7.06, 8.3, 3.56, 11.03],
  '16/500': [9.98, 9.98, 9.98, 9.98, 9.98, 9.98, 9.98, 9.98, 9.98, 9.98, 4.06, 4.91, 7.81, 9.98, 9.98, 15.08, 11.08, 4.72, 6.05, 6.05, 7.31, 9.36, 4.72, 6.69, 4.72, 4.72, 4.72, 4.72, 9.53, 8.95, 9.53, 8.12, 14.33, 10.61, 10.38, 11.12, 11.27, 9.36, 8.98, 11.55, 11.78, 4.25, 8.59, 10.45, 8.92, 13.84, 11.7, 11.8, 10.06, 11.8, 10.36, 10.09, 8.42, 11.53, 10.31, 14.98, 10.83, 9.28, 10.36, 6.05, 6.05, 9.27, 8.69, 9.3, 8.33, 9.3, 8.25, 6.03, 9.22, 9.34, 3.86, 3.86, 8.69, 3.97, 13.94, 9.27, 8.47, 9.23, 9.23, 6.08, 7.91, 5.77, 9.27, 8.58, 12.47, 8.38, 8.67, 8.47, 9.98, 4.17, 13.36],
  '17/500': [10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 4.22, 5.11, 8.2, 10.5, 10.5, 15.92, 11.66, 4.91, 6.33, 6.33, 7.66, 9.84, 4.91, 7, 4.91, 4.91, 4.91, 4.91, 10.02, 9.39, 10.02, 8.53, 15.11, 11.16, 10.92, 11.7, 11.86, 9.84, 9.44, 12.17, 12.41, 4.41, 9.03, 11, 9.38, 14.61, 12.33, 12.44, 10.58, 12.44, 10.91, 10.61, 8.83, 12.14, 10.84, 15.81, 11.39, 9.75, 10.89, 6.33, 6.33, 9.73, 9.12, 9.77, 8.73, 9.77, 8.66, 6.3, 9.69, 9.81, 3.98, 3.98, 9.12, 4.11, 14.7, 9.73, 8.89, 9.7, 9.7, 6.34, 8.28, 6.02, 9.73, 9.02, 13.14, 8.8, 9.11, 8.89, 10.5, 4.33, 14.09],
}

// What a run of text takes at a size and weight the table holds; a character it lacks, or a size it
// lacks, falls back to the padded estimate.
const textInk = (text: string, size: number, weight: 400 | 500) => {
  const row = ADVANCES[`${size}/${weight}`]
  if (!row) return px(text, size, weight === 500)
  return [...text].reduce((w, c) => {
    const i = ADVANCE_CHARS.indexOf(c)
    return w + (i >= 0 ? row[i]! : px(c, size, weight === 500))
  }, 0)
}

// The Last break heading, which names the cause, wraps at this many characters, about 300 pixels.
const BREAK_CHARS = 44

// ---- The first line ----

// The ink gap between neighbouring blocks on the first line, between the session's tiles, and between
// the last requests and the latest break.
const GAP = 24
const TILE_GAP = 16
const REQUESTS_GAP = 40

// A drawn row before it is placed: its markup, its own size and what it says in words.
type Piece = { body: string; width: number; height: number; alt: string }

// The first line is 44 high. The label with its state word, and each figure's ring, value and label,
// have the centroid of their filled pixels on one line; the numeral with its track is placed by its
// box instead, the numeral's top to the track's bottom half a pixel below the first ring's centre,
// which reads level, with the track on a whole pixel so it stays sharp. Measured in the app itself.
const GRID = { numeral: 31, track: 38, sideLabel: 19.85, sideWord: 34.35, value: 24, valueLabel: 37, middle: 24.5 }

// The countdown: one large light numeral for the one number that matters, a track under it that
// drains with the entry's life, and beside it what kind of cache this is and how it stands.
function instrument(v: View) {
  const tone = stateTone(v)
  const hasCache = v.cache.startedAt > 0
  const live = hasCache && !v.isExpired
  const big = !hasCache ? 'No cache yet' : v.isExpired ? 'Expired' : fmtClock(v.leftMs, v.ttl.ms)
  const size = live ? 30 : 22
  const bigW = Math.ceil(px(big, size) * 0.96)
  const label = hasCache ? ttlLabel(v).toUpperCase() : 'STARTS WITH YOUR NEXT MESSAGE'
  const word = live ? stateWord(v) : hasCache ? 'Your next message re-writes it' : ''
  // The track ends at bigW - 1, so the label and dot start one gap after it.
  const sideX = bigW - 1 + GAP
  const inkEnd = sideX + Math.max(labelInk(label), word ? (live ? 12 : 0) + textInk(word, 12, 500) : 0)
  const width = Math.ceil(inkEnd) + 1
  const height = 44
  const numeralFill = live && tone !== 'warm' ? TONE_VAR[tone] : live ? 'var(--fg)' : 'var(--muted)'
  const frac = live ? Math.min(1, Math.max(0, v.leftMs / v.ttl.ms)) : 0
  const track = live
    ? `<rect x="1" y="${GRID.track}" width="${bigW - 2}" height="3" rx="1.5" fill="var(--faint)"/>` +
      `<rect x="1" y="${GRID.track}" width="${Math.max(0, Math.round((bigW - 2) * frac))}" height="3" rx="1.5" fill="${TONE_VAR[tone]}"/>`
    : ''
  const dot = live ? `<circle cx="${sideX + 3.5}" cy="${GRID.sideWord - 4}" r="3.5" fill="${TONE_VAR[tone]}"/>` : ''
  const body =
    `<text x="${bigW / 2}" y="${GRID.numeral}" text-anchor="middle" font-size="${size}" font-weight="250" letter-spacing="-.5" fill="${numeralFill}">${esc(big)}</text>` +
    track +
    `<text class="label" x="${sideX}" y="${GRID.sideLabel}">${esc(label)}</text>` +
    dot +
    (word ? `<text x="${sideX + (live ? 12 : 0)}" y="${GRID.sideWord}" font-size="12" font-weight="500" fill="${live ? TONE_VAR[tone] : 'var(--muted)'}">${esc(word)}</text>` : '')
  const alt = [live ? `${big} left` : big, live ? stateWord(v) : '', hasCache ? ttlLabel(v) : ''].filter(Boolean).join(', ')
  return { body, width, height, alt, inkEnd }
}

// A ring that fills with a share, drawn around (cx, cy).
function ring(cx: number, cy: number, r: number, share: number, color: string) {
  const c = 2 * Math.PI * r
  const on = Math.max(0, Math.min(1, share)) * c
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--faint)" stroke-width="2.5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" ` +
    `stroke-dasharray="${on.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
  )
}

// Two figures with their labels under them, side by side: the hit rates, or once the entry has lapsed
// what the next message re-writes and roughly what that costs. `lead` is where the first figure's ink
// starts, so the gap before it matches the others.
function figures(v: View, lead: number): Piece | null {
  // Before the first request there is nothing to re-write and no rate yet.
  if (v.cache.startedAt === 0) return null
  const last = lastRequest(v)
  let blocks: { value: string; label: string; share?: number }[] = []
  let alt = ''
  if (v.isExpired) {
    const cost = rewriteCost(v)
    const tokens = v.cache.ctx > 0 ? fmtTokens(v.cache.ctx) : 'all'
    blocks = [{ value: tokens, label: 'TOKENS TO RE-WRITE' }, ...(cost === null ? [] : [{ value: fmtApprox(cost), label: 'NEXT MESSAGE COSTS' }])]
    alt = `next message re-writes ${v.cache.ctx > 0 ? `${tokens} tokens` : 'the whole context'}${cost === null ? '' : ` (${fmtApprox(cost)})`}`
  } else if (last) {
    const now = hitRate(last)
    const session = sessionHitRate(v)
    blocks = [
      { value: fmtPct(now), label: 'LAST REQUEST', share: now / 100 },
      { value: fmtPct(session), label: 'THIS SESSION', share: session / 100 },
    ]
    alt = `hit ${fmtPct(now)} last request · ${fmtPct(session)} this session`
  }
  if (blocks.length === 0) return null
  const height = 44
  // A ring's stroke starts 0.75 inside its drawn box; each block's ink starts one gap after the last
  // one's ends.
  const parts: string[] = []
  let inkStart = lead
  let end = 0
  blocks.forEach(b => {
    const x = b.share === undefined ? inkStart : inkStart - 0.75
    const textX = b.share === undefined ? x : x + 30
    if (b.share !== undefined) parts.push(ring(x + 11, GRID.middle, 9, b.share, 'var(--warm)'))
    parts.push(`<text x="${textX}" y="${GRID.value}" font-size="17" font-weight="500">${esc(b.value)}</text>`)
    parts.push(`<text class="label" x="${textX}" y="${GRID.valueLabel}">${esc(b.label)}</text>`)
    end = textX + Math.max(labelInk(b.label), textInk(b.value, 17, 500))
    inkStart = end + GAP
  })
  const width = Math.ceil(end) + 1
  return { body: parts.join(''), width, height, alt }
}

// ---- The detail ----

// The session's numbers as tiles in one row under one heading.
function sessionTiles(v: View): Piece {
  const t = v.totals
  const tiles: [string, string][] =
    t.requests === 0
      ? []
      : [
          [fmtPct(sessionHitRate(v)), 'HIT RATE'],
          [String(t.requests), t.requests === 1 ? 'REQUEST' : 'REQUESTS'],
          [fmtTokens(t.read), 'READ'],
          [fmtTokens(t.written), 'WRITTEN'],
          ...(t.isPriced ? ([[fmtApprox(t.writeCostUsd), 'WRITE COST'], [fmtApprox(t.savingsUsd), 'SAVED']] as [string, string][]) : []),
        ]
  const head = '<text class="label" x="0" y="10">THIS SESSION</text>'
  if (tiles.length === 0)
    return { body: head + '<text class="muted" x="0" y="30" font-size="13">No requests yet</text>', width: 160, height: 36, alt: 'This session: No requests yet' }
  // Each tile is as wide as its wider line, with the figure and its label centred on one another, and
  // one tile gap from the next. A spaced label's advance ends in one letter space past its ink, so its
  // centre sits half that to the right.
  let x = 0
  const parts = [head]
  tiles.forEach(([value, label], i) => {
    if (i > 0) x += TILE_GAP
    const inner = Math.max(textInk(value, 16, 500), labelInk(label))
    const mid = x + inner / 2
    parts.push(
      `<text x="${mid}" y="31" text-anchor="middle" font-size="16" font-weight="500">${esc(value)}</text>`,
      `<text class="label" x="${mid + 0.63}" y="45" text-anchor="middle">${esc(label)}</text>`,
    )
    x += inner
  })
  const alt = `This session: ${tiles.map(([value, label]) => `${value} ${label.toLowerCase()}`).join(', ')}`
  return { body: parts.join(''), width: Math.max(x, labelInk('THIS SESSION')), height: 47, alt }
}

const RECENT = 10

// The last ten requests as ten places, filled from the left as requests arrive: a mark each, red
// where the cache read dropped, under a heading that counts the breaks. An image like the other
// drawings, so it follows the appearance.
function recentStrip(v: View): Piece {
  const shown = v.history.slice(-RECENT)
  const breaks = shown.filter(r => r.isBreak).length
  const words = `${breaks === 0 ? 'No cache break' : breaks === 1 ? '1 cache break' : `${breaks} cache breaks`} in the last ${shown.length}`
  const heading = `${shown.length === 1 ? 'LAST REQUEST' : `LAST ${shown.length} REQUESTS`}: ${breaks === 0 ? 'NO CACHE BREAK' : breaks === 1 ? '1 CACHE BREAK' : `${breaks} CACHE BREAKS`}`
  const STEP = 18
  const parts = [`<text class="label" x="0" y="10">${esc(heading)}</text>`]
  for (let i = 0; i < RECENT; i++) {
    const cx = 6 + i * STEP
    const r = shown[i]
    if (!r) parts.push(`<circle cx="${cx}" cy="25" r="4.5" fill="none" stroke="var(--faint)" stroke-width="1.5"/>`)
    else if (r.isBreak) parts.push(`<path d="M${cx} 19.5 L${cx + 6} 30 L${cx - 6} 30 Z" fill="var(--danger)"/>`)
    else parts.push(`<circle cx="${cx}" cy="25" r="4.5" fill="var(--warm)"/>`)
  }
  const width = Math.ceil(Math.max(6 + (RECENT - 1) * STEP + 6, labelInk(heading)) + 1)
  const height = 31
  const alt = `Last ${shown.length} requests: ${shown.map(r => (r.isBreak ? '▲' : '●')).join(' ')}, ${words.charAt(0).toLowerCase()}${words.slice(1)}`
  return { body: parts.join(''), width, height, alt }
}

// The latest break: when, how much it re-wrote and what that cost, and why, in words.
function lastBreak(v: View): Piece | null {
  const latest = v.breaks[v.breaks.length - 1]
  if (!latest) return null
  const more = v.breaks.length - 1
  const facts = [fmtLocalTime(latest.at), `${fmtTokens(latest.written)} re-written`, ...(latest.costUsd !== null ? [fmtApprox(latest.costUsd)] : [])].join('  ·  ')
  // The heading names the cause, and a drawing cannot reflow, so it wraps at a width that fits a
  // narrow band; the time, what was re-written and its cost sit under it.
  const lines = wrapWords(`LAST BREAK: ${latest.cause.toUpperCase()}` + (more > 0 ? ` (AND ${more} MORE BEFORE IT)` : ''), BREAK_CHARS)
  const factsY = 10 + (lines.length - 1) * 12 + 17
  const height = factsY + 3
  const width = Math.ceil(Math.max(textInk(facts, 13, 500), ...lines.map(labelInk)) + 1)
  const parts = [
    ...lines.map((l, i) => `<text class="label" x="0" y="${10 + i * 12}">${esc(l)}</text>`),
    `<text x="0" y="${factsY}" font-size="13" font-weight="500">${esc(facts)}</text>`,
  ]
  const alt = `Last break: ${latest.cause}, ${fmtLocalTime(latest.at)}, ${fmtTokens(latest.written)} re-written${latest.costUsd !== null ? `, ${fmtApprox(latest.costUsd)}` : ''}${more > 0 ? `, and ${more} more` : ''}`
  return { body: parts.join(''), width, height, alt }
}

// ---- Keep warm: the app's own menus ----

function keepWarmRow(el: Desktop, v: View, a: Actions, notes: JSX.Element | null) {
  const { Box, Select } = el
  const choice = (which: 'lead' | 'cap') => (
    <Select
      key={which}
      label={FULL_NAMES[which]}
      options={OPTIONS[which].map(o => ({ value: o.value, label: o.label }))}
      value={currentOf(v, which)}
      onSelect={value => (which === 'lead' ? a.setLead : a.setIdleCap)(value)}
    />
  )
  return (
    <Box key="keepwarm" flexDirection="column">
      <Box key="choices" flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap">
        {choice('lead')}
        {choice('cap')}
      </Box>
      {notes}
    </Box>
  )
}

// What the pings have done and why keep warm paused, a drawing like the other rows so it shrinks
// with them; the choices above it are the app's own menus.
function keepWarmNotes(v: View): Piece | null {
  const notes = v.expanded ? pingsItems(v) : []
  if (v.paused !== '') notes.push(`Paused: you have been idle for ${v.paused}.`)
  if (notes.length === 0) return null
  const text = notes.join('  ·  ')
  return { body: `<text class="muted" x="0" y="13" font-size="12">${esc(text)}</text>`, width: Math.ceil(textInk(text, 12, 400)) + 1, height: 21, alt: text }
}

// A notice, drawn like the rows so it shrinks with them, its words wrapped to the rows' width so a
// long one never widens the band.
function noticePiece(text: string, width: number): Piece {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && textInk(`${last} ${word}`, 12, 400) <= width) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  const STEP = 16
  const body = lines.map((l, i) => `<text class="muted" x="0" y="${13 + i * STEP}" font-size="12">${esc(l)}</text>`).join('')
  return { body, width: Math.ceil(Math.max(...lines.map(l => textInk(l, 12, 400)))) + 1, height: 18 + (lines.length - 1) * STEP, alt: text }
}

// ---- The band ----

function button(el: Desktop, b: ButtonSpec) {
  const { Button } = el
  return (
    <Button
      key={b.key}
      label={b.label}
      onPress={b.press}
      {...(b.hotkey ? { hotkey: b.hotkey } : {})}
      {...(b.isPrimary ? { variant: 'primary' as const } : {})}
      {...(b.isDim ? { dimColor: true } : {})}
    />
  )
}

// Tucked away, the band is one small chip: a dot in the countdown's color, the time left and a
// button to bring the band back. The dot is a drawing in the band's own palette, so it is the same
// green as the expanded band's; the words are the app's own text, so they read in whatever font the
// app uses. Every piece, the separator dot included, is its own element with the same layout gap on
// each side, and the app centres them all on one line.
const CHIP_DOT = 10
// How wide a notice under the chip may run before its words wrap.
const CHIP_NOTICE_WIDTH = 360

function chip(el: Desktop, v: View, a: Actions, rest: JSX.Element) {
  const { Box, Button, Svg, Text } = el
  const hasCache = v.cache.startedAt > 0
  const live = hasCache && !v.isExpired
  const lead = !hasCache ? 'Cache Maxxer' : !live ? 'Cache expired' : stateWord(v) === 'Warm' ? 'Cache warm' : 'Cache expiring'
  const tail = !hasCache ? ['no cache yet'] : live ? [fmtClock(v.leftMs, v.ttl.ms), 'left'] : []
  const color = live ? TONE_VAR[stateTone(v)] : 'var(--muted)'
  // A notice still says itself while the band is tucked away, under the chip, as it would in the band.
  const notice = v.notice !== '' ? noticePiece(v.notice, CHIP_NOTICE_WIDTH) : null
  const dot = `<circle cx="${CHIP_DOT / 2}" cy="${CHIP_DOT / 2}" r="${CHIP_DOT / 2 - 0.5}" fill="${color}"/>`
  return (
    <Box flexDirection="column">
      <Box key="chip" flexDirection="row" alignItems="center" columnGap={1}>
        <Svg key="chip-dot" source={svg(CHIP_DOT, CHIP_DOT, dot)} alt={live ? stateWord(v) : lead} width={CHIP_DOT} height={CHIP_DOT} />
        <Text key="chip-lead" color="inactive">
          {lead}
        </Text>
        {tail.length > 0 ? (
          <Text key="chip-sep" color="inactive">
            ·
          </Text>
        ) : null}
        {tail.map((word, i) => (
          <Text key={`chip-${i}`} color="inactive">
            {word}
          </Text>
        ))}
        <Button key="show" label="Show" hotkey="h" onPress={a.show} />
      </Box>
      {notice ? <Svg key="chip-notice" source={svg(notice.width, notice.height, notice.body)} alt={notice.alt} width={notice.width} /> : null}
      {rest}
    </Box>
  )
}

// Two pieces side by side, the second `gap` after the first.
function beside(a: Piece, b: Piece | null, gap: number): Piece {
  if (!b) return a
  return {
    body: a.body + `<g transform="translate(${a.width + gap} 0)">${b.body}</g>`,
    width: a.width + gap + b.width,
    height: Math.max(a.height, b.height),
    alt: `${a.alt}; ${b.alt}`,
  }
}

// Each drawn row is one drawing, and every row is given one width: the widest row's. The app draws a
// drawing at its width and shrinks it to fit a narrower band, with no height given so its height
// follows, so every row shrinks by the same factor, text and marks together. A drawing given no width
// at all is stretched to fill the band instead. The buttons and the keep-warm menus are the app's own
// and sit beside or under the drawings where there is room.
export function desktopBand(el: Desktop, v: View, a: Actions, rest: JSX.Element) {
  const { Box, Svg } = el
  if (v.hidden) return chip(el, v, a, rest)
  const clock = instrument(v)
  const line = beside(clock, figures(v, GAP - (clock.width - clock.inkEnd)), 0)
  const recent = v.expanded && v.history.length > 0 ? recentStrip(v) : null
  const brk = v.expanded ? lastBreak(v) : null
  const requests = recent ? beside(recent, brk, REQUESTS_GAP) : brk
  const notes = v.settings.keepWarm ? keepWarmNotes(v) : null
  const rows = [line, ...(v.expanded ? [sessionTiles(v)] : []), ...(requests ? [requests] : []), ...(notes ? [notes] : [])]
  const W = Math.ceil(Math.max(...rows.map(r => r.width)))
  const draw = (key: string, p: Piece) => <Svg key={key} source={svg(W, p.height, p.body)} alt={p.alt} width={W} />
  const notice = v.notice !== '' ? noticePiece(v.notice, W) : null
  // Hide sits with the band's own buttons, after More.
  const buttons: ButtonSpec[] = [...mainButtons(v, a), { key: 'hide', label: 'Hide', isPrimary: false, hotkey: 'h', press: a.hide }]
  const main = (
    <Box key="main" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={4} rowGap={1}>
      {draw('status', line)}
      <Box key="buttons" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
        {buttons.map(b => button(el, b))}
      </Box>
    </Box>
  )

  const above: JSX.Element[] = []
  if (v.expanded) {
    above.push(draw('session', rows[1]!))
    if (requests) above.push(draw('requests', requests))
  }
  // The pings line sits close under the choices and the first line close under it: each drawing
  // brings a few pixels of its own room, so neither takes the band's full row gap.
  const warm = v.settings.keepWarm ? keepWarmRow(el, v, a, notes ? draw('notes', notes) : null) : null
  const bottom = warm && notes ? (
    <Box key="warm-and-main" flexDirection="column">
      {warm}
      {main}
    </Box>
  ) : null
  if (warm && !bottom) above.push(warm)
  // The frame takes the input box's own border color, so the band sits in the app like the box under it.
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1} rowGap={1}>
        {above}
        {bottom ?? main}
        {notice ? draw('notice', notice) : null}
      </Box>
      {rest}
    </Box>
  )
}
