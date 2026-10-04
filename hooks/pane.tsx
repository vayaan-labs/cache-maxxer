import type { ElementTable } from 'claude-code'

import type { Req } from '../types'
import { COLORS, colorProps, textPx } from './band'
import { fmtClock, fmtLocalTime, fmtTokens, fmtUsd } from './format'
import { HISTORY_LIMIT } from './model'
import { pingsLine, stateTone, stateWord, sessionHitRate, ttlLabel, type Tone, type View } from './view'

export type PaneActions = {
  toggleKeepWarm: () => void
  warmNow: () => void
  compact: () => void
  close: () => void
  setLead: (value: string) => void
  setIdleCap: (value: string) => void
}

// The picker draws "label: option", so the two read as one phrase: "Ping: 4 minutes before expiry".
const LEAD_OPTIONS = [
  { value: 'auto', label: 'automatically before expiry' },
  { value: '1m', label: '1 minute before expiry' },
  { value: '2m', label: '2 minutes before expiry' },
  { value: '4m', label: '4 minutes before expiry' },
  { value: '8m', label: '8 minutes before expiry' },
]
const CAP_OPTIONS = [
  { value: '1h', label: 'after 1 hour idle' },
  { value: '3h', label: 'after 3 hours idle' },
  { value: '8h', label: 'after 8 hours idle' },
  { value: 'none', label: 'never' },
]

type Run = { text: string; tone: Tone; bold?: boolean }

const muted = (text: string): Run => ({ text, tone: 'muted' })
const fig = (text: string): Run => ({ text, tone: 'fg' })
const SEP = muted(' · ')

const runsLength = (runs: readonly Run[]) => runs.reduce((n, r) => n + r.text.length, 0)

// Neighbouring runs of one tone draw as one piece of text.
function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    const prev = out[out.length - 1]
    if (prev && prev.tone === r.tone && prev.bold === r.bold) prev.text += r.text
    else out.push({ ...r })
  }
  return out
}

// Pieces joined by a muted separator; an empty piece leaves no separator behind.
function joined(pieces: readonly (readonly Run[])[]): Run[] {
  return pieces.filter(p => p.length > 0).flatMap((p, i) => (i === 0 ? [...p] : [SEP, ...p]))
}

// ---- The numbers, dropped from the end where the room is short ----

function numberItems(v: View): Run[][] {
  const t = v.totals
  const items: Run[][] = [
    [fig(`${sessionHitRate(v)}%`), muted(' hit')],
    [fig(String(t.requests)), muted(t.requests === 1 ? ' request' : ' requests')],
    [fig(fmtTokens(t.read)), muted(' read')],
    [fig(fmtTokens(t.written)), muted(' written')],
    [fig(fmtTokens(t.uncached)), muted(' uncached')],
  ]
  if (t.isPriced) items.push([muted('saved '), fig(`~${fmtUsd(t.savingsUsd)}`)], [muted('writes '), fig(`~${fmtUsd(t.writeCostUsd)}`)])
  return items
}

function numbersRuns(v: View, room: number): Run[] {
  if (v.totals.requests === 0) return [muted('No requests yet')]
  const items = numberItems(v)
  while (items.length > 1 && runsLength(joined(items)) > room) items.pop()
  return joined(items)
}

// ---- The latest break ----

function breakRuns(v: View, room: number): Run[] | null {
  const latest = v.breaks[v.breaks.length - 1]
  if (!latest) return null
  const more = v.breaks.length - 1
  const lead = (cause: Run[], tail: Run[]): Run[] => [
    { text: '▲ ', tone: 'danger' },
    muted('Last break '),
    ...joined([
      [fig(fmtLocalTime(latest.at))],
      [fig(fmtTokens(latest.written)), muted(' re-written')],
      ...(latest.costUsd === null ? [] : [[fig(`~${fmtUsd(latest.costUsd)}`)]]),
      cause,
    ]),
    ...tail,
  ]
  const tail = more > 0 ? [muted(` · and ${more} more`)] : []
  const full = lead([muted(latest.cause)], tail)
  if (runsLength(full) <= room) return full
  // The cause gives way first, with an ellipsis; the count of earlier breaks is kept while it can be.
  for (const kept of [tail, []]) {
    const spare = room - runsLength(lead([], kept)) - SEP.text.length
    if (spare >= 12) return lead([muted(`${latest.cause.slice(0, spare - 1)}…`)], kept)
  }
  return lead([], [])
}

// ---- The history of the last requests, newest on the right ----

const tokensOf = (r: Req) => r.read + r.written + r.uncached
const PART_TONES: readonly Tone[] = ['warm', 'warn', 'muted']

// Where each part of a request's bar ends, bottom to top: read, then written, then uncached.
function stack(r: Req, scale: number): number[] {
  const read = Math.round(r.read * scale)
  const written = read + Math.round(r.written * scale)
  const total = Math.max(written + Math.round(r.uncached * scale), 1)
  return [read, written, total]
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█'
const LEGEND_WIDTH = '   ■ read  ■ written  ■ uncached  ▲ break'.length
const MIN_CELLS = 8

// One cell per request: as tall as the request is big next to the others, in the colour of its largest part.
function terminalHistoryRuns(history: readonly Req[], columns: number): Run[] {
  const label = (n: number) => ` last ${n}`
  let cells = Math.min(history.length, HISTORY_LIMIT, columns - 6 - label(HISTORY_LIMIT).length - LEGEND_WIDTH)
  const hasLegend = cells >= Math.min(MIN_CELLS, history.length)
  if (!hasLegend) cells = Math.min(history.length, HISTORY_LIMIT, columns - 6 - label(HISTORY_LIMIT).length)
  const shown = history.slice(-Math.max(1, cells))
  const max = Math.max(1, ...shown.map(tokensOf))
  const bars: Run[] = shown.map(r => {
    if (r.isBreak) return { text: '▲', tone: 'danger' as Tone }
    const parts = [r.read, r.written, r.uncached]
    const part = parts.indexOf(Math.max(...parts))
    const level = Math.min(8, Math.max(1, Math.ceil((tokensOf(r) / max) * 8)))
    return { text: EIGHTHS[level]!, tone: PART_TONES[part]! }
  })
  const runs = [...mergeRuns(bars), muted(label(shown.length))]
  if (!hasLegend) return runs
  return [
    ...runs,
    muted('   '),
    { text: '■ ', tone: 'warm' },
    muted('read  '),
    { text: '■ ', tone: 'warn' },
    muted('written  '),
    muted('■ uncached  '),
    { text: '▲ ', tone: 'danger' },
    muted('break'),
  ]
}

const BAR = 5
const BAR_GAP = 2
const STRIP_HEIGHT = 28
const BAR_AREA = 21
const FONT_RATIO = 1 / 12

// The desktop keeps the stacked bars, one strip tall, with the legend after them.
function desktopHistory(el: ElementTable<'desktop'>, history: readonly Req[], columns: number) {
  const { Svg } = el
  const room = Math.max(160, columns * 7.5 - 230)
  const cells = Math.max(MIN_CELLS, Math.min(HISTORY_LIMIT, Math.floor(room / (BAR + BAR_GAP))))
  const shown = history.slice(-cells)
  const max = Math.max(1, ...shown.map(tokensOf))
  const scale = BAR_AREA / max
  const base = 2 + BAR_AREA
  const parts: string[] = []
  shown.forEach((r, i) => {
    const x = i * (BAR + BAR_GAP)
    const ends = stack(r, scale)
    const spans: [number, number, Tone][] = [
      [0, ends[0]!, 'warm'],
      [ends[0]!, ends[1]!, 'warn'],
      [ends[1]!, ends[2]!, 'muted'],
    ]
    for (const [from, to, tone] of spans) {
      if (to - from <= 0) continue
      parts.push(`<rect x="${x}" y="${base - to}" width="${BAR}" height="${to - from}" rx="1" fill="${COLORS[tone]}"/>`)
    }
    if (r.isBreak) {
      const cx = x + BAR / 2
      parts.push(`<polygon points="${cx - 3},${STRIP_HEIGHT - 0.5} ${cx + 3},${STRIP_HEIGHT - 0.5} ${cx},${base + 1.5}" fill="${COLORS.danger}"/>`)
    }
  })
  const barsWidth = shown.length * (BAR + BAR_GAP)
  let lx = barsWidth + 10
  const count = `last ${shown.length}`
  parts.push(`<text x="${lx}" y="${base - 6}" font-size="11" fill="${COLORS.muted}">${count}</text>`)
  lx += textPx(count) * (11 / 12) + 14
  const legend = [
    ['read', 'warm'],
    ['written', 'warn'],
    ['uncached', 'muted'],
    ['break', 'danger'],
  ] as const
  for (const [name, tone] of legend) {
    parts.push(
      `<circle cx="${lx + 4}" cy="${base - 9.5}" r="3.5" fill="${COLORS[tone]}"/><text x="${lx + 12}" y="${base - 6}" font-size="11" fill="${COLORS.muted}">${name}</text>`,
    )
    lx += 12 + textPx(name) * (11 / 12) + 16
  }
  const width = Math.ceil(Math.max(barsWidth, lx))
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${STRIP_HEIGHT}" viewBox="0 0 ${width} ${STRIP_HEIGHT}">` +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}</style>' +
    parts.join('') +
    '</svg>'
  const alt = `Tokens per request for the last ${shown.length} requests, newest on the right: read, written and uncached, breaks marked.`
  return <Svg source={source} alt={alt} width={width} height={STRIP_HEIGHT} />
}

// ---- The countdown, the cache length and the state ----

const stateDot = (tone: Tone) => (tone === 'warm' ? '●' : tone === 'muted' ? '○' : '◐')

function headerText(v: View) {
  const tone = stateTone(v)
  const hasCache = v.cache.startedAt > 0
  const runs: Run[] = [{ text: `${stateDot(tone)} `, tone }]
  if (!hasCache) runs.push({ text: 'No cache yet', tone: 'muted', bold: true })
  else if (v.isExpired) runs.push({ text: 'expired', tone: 'muted', bold: true })
  else runs.push({ text: fmtClock(v.leftMs, v.ttl.ms), tone, bold: true })
  runs.push(muted(`  ${ttlLabel(v)}`))
  if (hasCache && !v.isExpired) runs.push({ text: `  ${stateWord(v)}`, tone })
  return runs
}

function desktopHeader(el: ElementTable<'desktop'>, v: View) {
  const { Svg } = el
  const tone = stateTone(v)
  const color = COLORS[tone]
  const hasCache = v.cache.startedAt > 0
  const live = hasCache && !v.isExpired
  const big = !hasCache ? 'No cache yet' : v.isExpired ? 'expired' : fmtClock(v.leftMs, v.ttl.ms)
  const size = live ? 22 : 17
  const x = 22
  const bigPx = textPx(big, true) * size * FONT_RATIO
  const word = live ? stateWord(v) : ''
  const ttl = ttlLabel(v)
  const wordPx = word ? textPx(word, true) * (13 / 12) : 0
  const dot =
    tone === 'warm'
      ? `<circle cx="9" cy="14" r="5" fill="${color}"/>`
      : tone === 'muted'
        ? `<circle cx="9" cy="14" r="4.2" fill="none" stroke="${color}" stroke-width="1.6"/>`
        : `<circle cx="9" cy="14" r="4.2" fill="none" stroke="${color}" stroke-width="1.6"/><path d="M9 9.8 A4.2 4.2 0 0 0 9 18.2 Z" fill="${color}"/>`
  const afterX = x + bigPx + 12
  // The SVG cannot measure its own text, so the width errs wide.
  const width = Math.ceil(afterX + wordPx * 1.1 + (word ? 10 : 0) + textPx(ttl) * (13 / 12) * 1.12 + 6)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${STRIP_HEIGHT}" viewBox="0 0 ${width} ${STRIP_HEIGHT}">` +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}</style>' +
    dot +
    `<text x="${x}" y="22" font-size="${size}" font-weight="600" fill="${color}">${big}</text>` +
    `<text x="${afterX}" y="20" font-size="13" xml:space="preserve">` +
    (word ? `<tspan font-weight="600" fill="${color}">${word}</tspan><tspan dx="10" fill="${COLORS.muted}">${ttl}</tspan>` : `<tspan fill="${COLORS.muted}">${ttl}</tspan>`) +
    '</text></svg>'
  return { node: <Svg source={source} alt={`${big}, ${word || 'no live cache'}, ${ttl}`} width={width} height={STRIP_HEIGHT} />, width }
}

// ---- The pane ----

// The common part of both surfaces' element tables; the lines below use nothing else.
type Common = ElementTable<'terminal'>

// What differs between the surfaces: the first piece of line 1, the history line, and how wide a control draws.
type Surface = {
  header: JSX.Element
  headerWidth: number
  history: JSX.Element
  // Null where the surface's own frame already draws a close control (the terminal's pane border does)
  closeLabel: string | null
  buttonWidth: (label: string) => number
  pickerChrome: number
}

function runsRow(el: Common, runs: readonly Run[], key: string) {
  const { Box, Text } = el
  return (
    <Box key={key} flexDirection="row">
      {mergeRuns(runs).map((r, i) => (
        <Text key={`${key}-${i}`} {...colorProps(r.tone)} {...(r.bold ? { bold: true } : {})}>
          {r.text}
        </Text>
      ))}
    </Box>
  )
}

function body(el: Common, v: View, a: PaneActions, columns: number, s: Surface) {
  const { Box, Button, Select } = el
  // The pane's frame and padding take a few columns of the width it is given
  const room = Math.max(20, columns - 6)
  const hasCache = v.cache.startedAt > 0
  const keepWarm = v.settings.keepWarm

  const specs = [
    ...(hasCache && !v.isExpired ? [{ key: 'warm', label: 'Warm now', press: a.warmNow, isPrimary: false, isDismiss: false }] : []),
    { key: 'keep', label: `Keep warm: ${keepWarm ? 'on' : 'off'}`, press: a.toggleKeepWarm, isPrimary: keepWarm, isDismiss: false },
    { key: 'compact', label: 'Compact', press: a.compact, isPrimary: false, isDismiss: false },
    ...(s.closeLabel === null ? [] : [{ key: 'close', label: s.closeLabel, press: a.close, isPrimary: false, isDismiss: true }]),
  ]
  const buttons = specs.map(b => (
    <Button
      key={b.key}
      label={b.label}
      onPress={b.press}
      {...(b.isPrimary ? { variant: 'primary' as const } : {})}
      {...(b.isDismiss ? { role: 'dismiss' as const } : {})}
    />
  ))
  const actionsWidth = specs.reduce((n, b) => n + s.buttonWidth(b.label), 0) + (specs.length - 1)
  const buttonRow = (
    <Box key="buttons" flexDirection="row" columnGap={1} alignItems="center">
      {buttons}
    </Box>
  )
  // One row where the room allows; the actions drop to their own row beneath rather than wrapping the text.
  const isOneRow = s.headerWidth + 2 + actionsWidth <= room
  const top = isOneRow ? (
    <Box key="top" flexDirection="row" justifyContent="space-between" alignItems="center">
      {s.header}
      {buttonRow}
    </Box>
  ) : (
    <Box key="top" flexDirection="column">
      {s.header}
      {buttonRow}
    </Box>
  )

  const lines: JSX.Element[] = [top, runsRow(el, numbersRuns(v, room), 'numbers')]
  if (v.history.length > 0) lines.push(s.history)
  const brk = breakRuns(v, room)
  if (brk) lines.push(runsRow(el, brk, 'break'))
  if (keepWarm) {
    const pings: Run[] = [muted(pingsLine(v.pings))]
    if (v.paused) pings.push(muted(`  Paused: you have been idle for ${v.paused}.`))
    const leadLabel = LEAD_OPTIONS.find(o => o.value === v.settings.lead)?.label ?? ''
    const capLabel = CAP_OPTIONS.find(o => o.value === v.settings.idleCap)?.label ?? ''
    const pickersWidth = 'Ping'.length + leadLabel.length + 'Stop'.length + capLabel.length + 2 * s.pickerChrome + 3
    const isBeside = pickersWidth + 3 + runsLength(pings) <= room
    const pickers = (
      <Box key="pickers" flexDirection="row" columnGap={3}>
        <Select key="lead" label="Ping" options={LEAD_OPTIONS} value={v.settings.lead} onSelect={a.setLead} />
        <Select key="cap" label="Stop" options={CAP_OPTIONS} value={v.settings.idleCap} onSelect={a.setIdleCap} />
      </Box>
    )
    if (isBeside) {
      lines.push(
        <Box key="keepwarm" flexDirection="row" columnGap={3}>
          {pickers}
          {runsRow(el, pings, 'pings')}
        </Box>,
      )
    } else {
      lines.push(pickers, runsRow(el, pings, 'pings'))
    }
  }
  return <Box flexDirection="column">{lines}</Box>
}

export function terminalPane(el: ElementTable<'terminal'>, v: View, columns: number, a: PaneActions) {
  const header = headerText(v)
  return body(el, v, a, columns, {
    header: runsRow(el, header, 'header'),
    headerWidth: runsLength(header),
    history: runsRow(el, v.history.length > 0 ? terminalHistoryRuns(v.history, columns) : [], 'history'),
    closeLabel: null,
    buttonWidth: label => label.length + 4,
    pickerChrome: 4,
  })
}

export function desktopPane(el: ElementTable<'desktop'>, v: View, columns: number, a: PaneActions) {
  const header = desktopHeader(el, v)
  // Box, Text, Button and Select draw the same on both surfaces.
  return body(el as unknown as Common, v, a, columns, {
    header: header.node,
    // Pixels turned into the columns the room is measured in
    headerWidth: header.width / 7.5,
    history: desktopHistory(el, v.history, columns),
    closeLabel: 'Close',
    buttonWidth: label => (label.length * 7.2 + 30) / 7.5,
    pickerChrome: 12,
  })
}
