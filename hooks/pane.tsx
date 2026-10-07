import type { ElementTable } from 'claude-code'

import type { Req } from '../types'
import { COLORS, colorProps, keepWarmButton, textPx, type ButtonSpec } from './band'
import { fmtApprox, fmtClock, fmtLocalTime, fmtTokens } from './format'
import { flowRows, wrapWords } from './layout'
import { HISTORY_LIMIT } from './model'
import { pingsItems, stateTone, stateWord, sessionHitRate, ttlLabel, ttlShort, type Tone, type View } from './view'

export type PaneActions = {
  toggleKeepWarm: () => void
  warmNow: () => void
  compact: () => void
  close: () => void
  // Opens a keep-warm picker's list, or closes it if that one is open
  togglePicker: (which: 'lead' | 'cap') => void
  setLead: (value: string) => void
  setIdleCap: (value: string) => void
}

// A closed picker draws as a button reading "label: option ▾", so it reads as something to press. Its
// list is a row of buttons, one per option: a click or Enter on one chooses it.
type Option = { value: string; label: string }
type Pickers = { lead: readonly Option[]; cap: readonly Option[] }

const FULL_PICKERS: Pickers = {
  lead: [
    { value: 'auto', label: 'automatically before expiry' },
    { value: '1m', label: '1 minute before expiry' },
    { value: '2m', label: '2 minutes before expiry' },
    { value: '4m', label: '4 minutes before expiry' },
    { value: '8m', label: '8 minutes before expiry' },
  ],
  cap: [
    { value: '1h', label: 'after 1 hour idle' },
    { value: '3h', label: 'after 3 hours idle' },
    { value: '8h', label: 'after 8 hours idle' },
    { value: 'none', label: 'never' },
  ],
}

// The same choices in fewer words, for the row where the full ones leave no room for the pings.
const SHORT_PICKERS: Pickers = {
  lead: [
    { value: 'auto', label: 'auto' },
    { value: '1m', label: '1m before' },
    { value: '2m', label: '2m before' },
    { value: '4m', label: '4m before' },
    { value: '8m', label: '8m before' },
  ],
  cap: [
    { value: '1h', label: '1h idle' },
    { value: '3h', label: '3h idle' },
    { value: '8h', label: '8h idle' },
    { value: 'none', label: 'never' },
  ],
}

// What an open list shows: what it asks, and its options in the words of a list.
const OPEN_LISTS: Record<'lead' | 'cap', { ask: string; options: readonly Option[] }> = {
  lead: {
    ask: 'Ping before expiry:',
    options: [
      { value: 'auto', label: 'automatic' },
      { value: '1m', label: '1 minute' },
      { value: '2m', label: '2 minutes' },
      { value: '4m', label: '4 minutes' },
      { value: '8m', label: '8 minutes' },
    ],
  },
  cap: {
    ask: 'Stop when idle for:',
    options: [
      { value: '1h', label: '1 hour' },
      { value: '3h', label: '3 hours' },
      { value: '8h', label: '8 hours' },
      { value: 'none', label: 'never stop' },
    ],
  },
}

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

// ---- The numbers, flowing onto more rows where the room is short ----

function numberItems(v: View): Run[][] {
  const t = v.totals
  const items: Run[][] = [
    [fig(`${sessionHitRate(v)}%`), muted(' hit')],
    [fig(String(t.requests)), muted(t.requests === 1 ? ' request' : ' requests')],
    [fig(fmtTokens(t.read)), muted(' read')],
    [fig(fmtTokens(t.written)), muted(' written')],
    [fig(fmtTokens(t.uncached)), muted(' uncached')],
  ]
  if (t.isPriced) items.push([muted('saved '), fig(fmtApprox(t.savingsUsd))], [muted('writes '), fig(fmtApprox(t.writeCostUsd))])
  return items
}

// Every number stays: they fill a row and the rest start the next one, never splitting a number.
function numbersRows(v: View, room: number): Run[][] {
  if (v.totals.requests === 0) return [[muted('No requests yet')]]
  return flowRows(numberItems(v), runsLength, SEP.text.length, room).map(joined)
}

// ---- The latest break ----

// The latest break: when, how much was re-written, what it cost, why, and how many came before. The
// pieces fill a row and the rest start the next one; a cause too long for a row is cut at its spaces.
function breakRows(v: View, room: number): Run[][] | null {
  const latest = v.breaks[v.breaks.length - 1]
  if (!latest) return null
  const more = v.breaks.length - 1
  type Piece = { runs: Run[]; words?: string }
  const pieces: Piece[] = [
    { runs: [{ text: '▲ ', tone: 'danger' }, muted('Last break '), fig(fmtLocalTime(latest.at))] },
    { runs: [fig(fmtTokens(latest.written)), muted(' re-written')] },
    ...(latest.costUsd !== null ? [{ runs: [fig(fmtApprox(latest.costUsd))] }] : []),
    { runs: [muted(latest.cause)], words: latest.cause },
    ...(more > 0 ? [{ runs: [muted(`and ${more} more`)] }] : []),
  ]
  return flowRows(pieces, p => runsLength(p.runs), SEP.text.length, room).flatMap(row => {
    const only = row[0]!
    if (row.length === 1 && only.words !== undefined && runsLength(only.runs) > room) {
      return wrapWords(only.words, room).map(line => [muted(line)])
    }
    return [joined(row.map(p => p.runs))]
  })
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
// The legend follows the bars on their row where there is room, else on a row or two of its own.
function terminalHistoryRows(history: readonly Req[], room: number): Run[][] {
  const label = (n: number) => ` last ${n}`
  let cells = Math.min(history.length, HISTORY_LIMIT, room - label(HISTORY_LIMIT).length - LEGEND_WIDTH)
  const hasInlineLegend = cells >= Math.min(MIN_CELLS, history.length)
  if (!hasInlineLegend) cells = Math.min(history.length, HISTORY_LIMIT, room - label(HISTORY_LIMIT).length)
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
  const legend: Run[][] = [
    [{ text: '■ ', tone: 'warm' }, muted('read')],
    [{ text: '■ ', tone: 'warn' }, muted('written')],
    [muted('■ uncached')],
    [{ text: '▲ ', tone: 'danger' }, muted('break')],
  ]
  if (hasInlineLegend) return [[...runs, muted('   '), ...legend.flatMap((item, i) => (i === 0 ? item : [muted('  '), ...item]))]]
  const legendRows = flowRows(legend, runsLength, 2, room).map(row => row.flatMap((item, i) => (i === 0 ? item : [muted('  '), ...item])))
  return [runs, ...legendRows]
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

// How much the first line shows: everything; the cache length shortened; no cache length; or the
// countdown alone, its colour still saying the state.
type HeaderLevel = 0 | 1 | 2 | 3
const HEADER_LEVELS: readonly HeaderLevel[] = [0, 1, 2, 3]
const lengthText = (v: View, level: HeaderLevel) => (level === 0 ? ttlLabel(v) : level === 1 ? ttlShort(v) : '')
const hasStateWord = (level: HeaderLevel) => level < 3

function headerText(v: View, level: HeaderLevel) {
  const tone = stateTone(v)
  const hasCache = v.cache.startedAt > 0
  const runs: Run[] = [{ text: `${stateDot(tone)} `, tone }]
  if (!hasCache) runs.push({ text: 'No cache yet', tone: 'muted', bold: true })
  else if (v.isExpired) runs.push({ text: 'expired', tone: 'muted', bold: true })
  else runs.push({ text: fmtClock(v.leftMs, v.ttl.ms), tone, bold: true })
  if (level < 2) runs.push(muted(`  ${lengthText(v, level)}`))
  if (hasCache && !v.isExpired && hasStateWord(level)) runs.push({ text: `  ${stateWord(v)}`, tone })
  return runs
}

function desktopHeader(el: ElementTable<'desktop'>, v: View, level: HeaderLevel) {
  const { Svg } = el
  const tone = stateTone(v)
  const color = COLORS[tone]
  const hasCache = v.cache.startedAt > 0
  const live = hasCache && !v.isExpired
  const big = !hasCache ? 'No cache yet' : v.isExpired ? 'expired' : fmtClock(v.leftMs, v.ttl.ms)
  const size = live ? 22 : 17
  const x = 22
  const bigPx = textPx(big, true) * size * FONT_RATIO
  const word = live && hasStateWord(level) ? stateWord(v) : ''
  const ttl = lengthText(v, level)
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
  return { node: <Svg source={source} alt={`${big}, ${live ? stateWord(v) : 'no live cache'}, ${ttlLabel(v)}`} width={width} height={STRIP_HEIGHT} />, width }
}

// ---- The pane ----

// The common part of both surfaces' element tables; the lines below use nothing else.
type Common = ElementTable<'terminal'>

// What differs between the surfaces: the first piece of the status row, the history rows, and how wide a control draws.
type Surface = {
  // The columns the pane's frame and padding take of the width it is given
  inset: number
  // The first piece of the status row at each level of detail, with the columns it takes
  header: (level: HeaderLevel) => { node: JSX.Element; width: number }
  history: (room: number) => JSX.Element[]
  // Null where the surface's own frame already draws a close control (the terminal's pane border does)
  closeLabel: string | null
  buttonWidth: (label: string) => number
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

// ---- Buttons and text that share rows, flowing onto the next row where the room runs out ----

type PaneButton = ButtonSpec & { isDismiss?: boolean }

// One thing on a row: a button, or text that starts with a lead (two spaces, or a dot) that goes when
// the text starts a row.
type Cell = { key: string; width: number; button?: PaneButton; runs?: Run[]; lead?: string }

const buttonCell = (b: PaneButton, s: Surface): Cell => ({ key: b.key, width: s.buttonWidth(b.label), button: b })
const textCell = (key: string, runs: Run[], lead: string): Cell => ({ key, width: runsLength(runs) + lead.length, runs, lead })

// Text as cells: one where it fits a row, else its lines cut at spaces, each taking a row of its own.
function textCells(key: string, text: string, tone: Tone, lead: string, room: number): Cell[] {
  if (text.length + lead.length <= room) return [textCell(key, [{ text, tone }], lead)]
  return wrapWords(text, room).map((line, i) => ({ key: `${key}-${i}`, width: room, runs: [{ text: line, tone }], lead: '' }))
}

function buttonEl(el: Common, b: PaneButton) {
  const { Button } = el
  return (
    <Button
      key={b.key}
      label={b.label}
      onPress={b.press}
      {...(b.isPrimary ? { variant: 'primary' as const } : {})}
      {...(b.isDismiss ? { role: 'dismiss' as const } : {})}
    />
  )
}

// Text cells that sit side by side draw as one piece of text, joined by their leads.
function cellRows(el: Common, cells: readonly Cell[], room: number, keyPrefix: string): JSX.Element[] {
  const { Box } = el
  return flowRows(cells, c => c.width, 1, room).map((row, r) => {
    const parts: JSX.Element[] = []
    let text: { key: string; runs: Run[] } | null = null
    const flush = () => {
      if (text) parts.push(runsRow(el, text.runs, text.key))
      text = null
    }
    row.forEach((c, i) => {
      if (c.button) {
        flush()
        parts.push(buttonEl(el, c.button))
      } else if (text) {
        text.runs.push(muted(` ${c.lead!}`), ...c.runs!)
      } else {
        text = { key: c.key, runs: i === 0 ? [...c.runs!] : [muted(c.lead!), ...c.runs!] }
      }
    })
    flush()
    return (
      <Box key={`${keyPrefix}${r}`} flexDirection="row" columnGap={1} alignItems="center">
        {parts}
      </Box>
    )
  })
}

// ---- The keep-warm rows: the two pickers and the pings, or one picker's open list ----

const PICKER_NAMES = { lead: 'Ping', cap: 'Stop' } as const
const PICKER_HINT = 'click or Enter to change'

function closedCells(v: View, a: PaneActions, s: Surface, p: Pickers, room: number): Cell[] {
  const picker = (which: 'lead' | 'cap'): Cell => {
    const current = which === 'lead' ? v.settings.lead : v.settings.idleCap
    const label = p[which].find(o => o.value === current)?.label ?? ''
    return buttonCell({ key: which, label: `${PICKER_NAMES[which]}: ${label} ▾`, isPrimary: false, press: () => a.togglePicker(which) }, s)
  }
  const isFull = p === FULL_PICKERS
  const items = pingsItems(v.pings)
  if (v.paused !== '') items.push(isFull ? `Paused: you have been idle for ${v.paused}.` : `Paused: idle for ${v.paused}.`)
  return [picker('lead'), picker('cap'), ...items.flatMap((text, i) => textCells(`ping${i}`, text, 'muted', i === 0 ? '  ' : '· ', room))]
}

function openCells(v: View, a: PaneActions, s: Surface, which: 'lead' | 'cap', room: number): Cell[] {
  const list = OPEN_LISTS[which]
  const current = which === 'lead' ? v.settings.lead : v.settings.idleCap
  const choose = which === 'lead' ? a.setLead : a.setIdleCap
  return [
    ...textCells('ask', list.ask, 'fg', '', room),
    ...textCells('how', '(click one, or Tab to it and press Enter)', 'muted', '', room),
    ...list.options.map(o =>
      buttonCell({ key: `${which}:${o.value}`, label: o.label, isPrimary: o.value === current, press: () => choose(o.value) }, s),
    ),
    buttonCell({ key: 'picker-cancel', label: 'Cancel', isPrimary: false, press: () => a.togglePicker(which) }, s),
  ]
}

function keepWarmRows(el: Common, v: View, a: PaneActions, room: number, s: Surface): JSX.Element[] {
  if (v.picker !== '') return cellRows(el, openCells(v, a, s, v.picker, room), room, 'keepwarm')
  // The full wording unless the short one fits a button into the row or saves a row.
  const full = closedCells(v, a, s, FULL_PICKERS, room)
  const short = closedCells(v, a, s, SHORT_PICKERS, room)
  const rowsOf = (cells: Cell[]) => flowRows(cells, c => c.width, 1, room)
  const cost = (cells: Cell[]) => (cells.some(c => c.width > room) ? 1000 : 0) + rowsOf(cells).length
  const cells = cost(short) < cost(full) ? short : full
  // The hint rides on the last row only where it fits, so it never costs a row.
  const last = rowsOf(cells).at(-1) ?? []
  const used = last.reduce((n, c) => n + c.width, 0) + Math.max(0, last.length - 1)
  const hint = textCell('hint', [muted(PICKER_HINT)], '· ')
  return cellRows(el, used + 1 + hint.width <= room ? [...cells, hint] : cells, room, 'keepwarm')
}

function body(el: Common, v: View, a: PaneActions, columns: number, s: Surface) {
  const { Box } = el
  const room = Math.max(20, columns - s.inset)
  const hasCache = v.cache.startedAt > 0

  const specs: PaneButton[] = [
    ...(hasCache && !v.isExpired ? [{ key: 'warm', label: 'Warm now', press: a.warmNow, isPrimary: false }] : []),
    keepWarmButton(v, a.toggleKeepWarm),
    { key: 'compact', label: 'Compact', press: a.compact, isPrimary: false },
    ...(s.closeLabel === null ? [] : [{ key: 'close', label: s.closeLabel, press: a.close, isPrimary: false, isDismiss: true }]),
  ]
  const buttons = specs.map(b => buttonCell(b, s))

  // The status and the buttons share rows. The status takes the richest wording that gives the fewest
  // rows, and sits three columns clear of the first button beside it.
  const statusGap = 2
  const levels = HEADER_LEVELS.map(s.header)
  const plans = levels.map(h => flowRows<Cell>([{ key: 'status', width: h.width + statusGap }, ...buttons], c => c.width, 1, room))
  const best = plans.reduce((bestIndex, p, i) => (p.length < plans[bestIndex]!.length ? i : bestIndex), 0)
  const [first = [], ...later] = plans[best]!
  const status = levels[best]!.node
  const actions = (key: string, cells: readonly Cell[]) => (
    <Box key={key} flexDirection="row" columnGap={1} alignItems="center">
      {cells.map(c => buttonEl(el, c.button!))}
    </Box>
  )
  const beside = first.slice(1)
  const top: JSX.Element[] = [
    beside.length > 0 ? (
      <Box key="top" flexDirection="row" justifyContent="space-between" alignItems="center">
        {status}
        {actions('actions', beside)}
      </Box>
    ) : (
      <Box key="top" flexDirection="row">
        {status}
      </Box>
    ),
    ...later.map((row, i) => actions(`more${i}`, row)),
  ]

  const lines: JSX.Element[] = [...top, ...numbersRows(v, room).map((runs, i) => runsRow(el, runs, `numbers${i}`))]
  if (v.history.length > 0) lines.push(...s.history(room))
  const brk = breakRows(v, room)
  if (brk) lines.push(...brk.map((runs, i) => runsRow(el, runs, `break${i}`)))
  if (v.settings.keepWarm) lines.push(...keepWarmRows(el, v, a, room, s))
  return <Box flexDirection="column">{lines}</Box>
}

export function terminalPane(el: ElementTable<'terminal'>, v: View, columns: number, a: PaneActions) {
  return body(el, v, a, columns, {
    // The body of the pane is exactly the width it is given (76 in a terminal 80 wide, 49 docked at the
    // side of one 120 wide); two columns stay spare for glyphs a terminal draws wide.
    inset: 2,
    header: level => {
      const runs = headerText(v, level)
      return { node: runsRow(el, runs, 'header'), width: runsLength(runs) }
    },
    history: room => terminalHistoryRows(v.history, room).map((runs, i) => runsRow(el, runs, `history${i}`)),
    closeLabel: null,
    buttonWidth: label => label.length + 4,
  })
}

export function desktopPane(el: ElementTable<'desktop'>, v: View, columns: number, a: PaneActions) {
  // Box, Text and Button draw the same on both surfaces.
  return body(el as unknown as Common, v, a, columns, {
    // The desktop's padding is not measured (the app is not driven here), so it keeps the wider margin.
    inset: 6,
    header: level => {
      const h = desktopHeader(el, v, level)
      // Pixels turned into the columns the room is measured in
      return { node: h.node, width: h.width / 7.5 }
    },
    history: () => [desktopHistory(el, v.history, columns)],
    closeLabel: 'Close',
    buttonWidth: label => (label.length * 7.2 + 30) / 7.5,
  })
}
