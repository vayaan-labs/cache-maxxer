import type { ElementTable } from 'claude-code'

import type { Req } from '../types'
import { COLORS, colorProps, textPx } from './band'
import { fmtClock, fmtLocalTime, fmtTokens, fmtUsd } from './format'
import { HISTORY_LIMIT } from './model'
import { pingsItems, stateTone, stateWord, sessionHitRate, ttlLabel, ttlShort, type Tone, type View } from './view'

export type PaneActions = {
  toggleKeepWarm: () => void
  warmNow: () => void
  compact: () => void
  close: () => void
  setLead: (value: string) => void
  setIdleCap: (value: string) => void
}

// The picker draws "label: option", so the two read as one phrase: "Ping: 4 minutes before expiry".
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

// The latest break on one line. As the room shrinks it drops pieces: the end of the cause (an ellipsis
// marks the cut), the count of earlier breaks, the cause, then the cost and the wording; the time and
// the size of the write stay.
function breakRuns(v: View, room: number): Run[] | null {
  const latest = v.breaks[v.breaks.length - 1]
  if (!latest) return null
  const more = v.breaks.length - 1
  const row = (heading: string, unit: string, isCostShown: boolean, cause: Run[], tail: Run[]): Run[] => [
    { text: '▲ ', tone: 'danger' },
    ...(heading === '' ? [] : [muted(`${heading} `)]),
    ...joined([
      [fig(fmtLocalTime(latest.at))],
      [fig(fmtTokens(latest.written)), ...(unit === '' ? [] : [muted(unit)])],
      ...(isCostShown && latest.costUsd !== null ? [[fig(`~${fmtUsd(latest.costUsd)}`)]] : []),
      cause,
    ]),
    ...tail,
  ]
  const tail = more > 0 ? [muted(` · and ${more} more`)] : []
  const full = row('Last break', ' re-written', true, [muted(latest.cause)], tail)
  if (runsLength(full) <= room) return full
  for (const kept of [tail, []]) {
    const spare = room - runsLength(row('Last break', ' re-written', true, [], kept)) - SEP.text.length
    if (spare >= 12) return row('Last break', ' re-written', true, [muted(`${latest.cause.slice(0, spare - 1)}…`)], kept)
  }
  const shapes: [string, string, boolean][] = [
    ['Last break', ' re-written', true],
    ['Last break', ' re-written', false],
    ['Break', ' re-written', false],
    ['', '', false],
  ]
  const forms = shapes.flatMap(([heading, unit, isCostShown]) => [tail, []].map(kept => row(heading, unit, isCostShown, [], kept)))
  return forms.find(f => runsLength(f) <= room) ?? forms[forms.length - 1]!
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
function terminalHistoryRuns(history: readonly Req[], room: number): Run[] {
  const label = (n: number) => ` last ${n}`
  let cells = Math.min(history.length, HISTORY_LIMIT, room - label(HISTORY_LIMIT).length - LEGEND_WIDTH)
  const hasLegend = cells >= Math.min(MIN_CELLS, history.length)
  if (!hasLegend) cells = Math.min(history.length, HISTORY_LIMIT, room - label(HISTORY_LIMIT).length)
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

// What differs between the surfaces: the first piece of line 1, the history line, and how wide a control draws.
type Surface = {
  // The columns the pane's frame and padding take of the width it is given
  inset: number
  // The first piece of line 1 at each level of detail, with the columns it takes
  header: (level: HeaderLevel) => { node: JSX.Element; width: number }
  history: (room: number) => JSX.Element
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

// ---- The keep-warm row: both pickers and the pings, always on one row ----

function pingsCandidates(v: View): Run[][] {
  const items = pingsItems(v.pings).map(text => [muted(text)])
  const paused = (text: string) => (v.paused === '' ? [] : [[muted(text)]])
  const long = paused(`Paused: you have been idle for ${v.paused}.`)
  const short = paused(`Paused: idle for ${v.paused}.`)
  const fewer = items.slice(1).map((_, i) => joined([...items.slice(0, items.length - 1 - i), ...short]))
  return [joined([...items, ...long]), joined([...items, ...short]), ...fewer, joined(short), []]
}

function keepWarmRow(el: Common, v: View, a: PaneActions, room: number, s: Surface) {
  const { Box, Select } = el
  const widthOf = (p: Pickers) => {
    const lead = p.lead.find(o => o.value === v.settings.lead)?.label ?? ''
    const cap = p.cap.find(o => o.value === v.settings.idleCap)?.label ?? ''
    return 'Ping'.length + lead.length + 'Stop'.length + cap.length + 2 * s.pickerChrome + 3
  }
  const candidates = pingsCandidates(v)
  const spareFor = (p: Pickers) => room - widthOf(p) - 3
  // The full wording when the pings still fit beside it, else the short wording with as much of the pings as fits.
  const fullFits = candidates.slice(0, 2).find(c => runsLength(c) <= spareFor(FULL_PICKERS))
  const [pickers, pings] = fullFits
    ? [FULL_PICKERS, fullFits]
    : [SHORT_PICKERS, candidates.find(c => runsLength(c) <= spareFor(SHORT_PICKERS)) ?? []]
  return (
    <Box key="keepwarm" flexDirection="row" columnGap={3}>
      <Box key="pickers" flexDirection="row" columnGap={3}>
        <Select key="lead" label="Ping" options={pickers.lead} value={v.settings.lead} onSelect={a.setLead} />
        <Select key="cap" label="Stop" options={pickers.cap} value={v.settings.idleCap} onSelect={a.setIdleCap} />
      </Box>
      {pings.length > 0 ? runsRow(el, pings, 'pings') : null}
    </Box>
  )
}

// What the pane promises: at most this many lines, in every state, from a pane 38 columns wide up.
const MAX_LINES = 5

function body(el: Common, v: View, a: PaneActions, columns: number, s: Surface) {
  const { Box, Button } = el
  const room = Math.max(20, columns - s.inset)
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
  const widths = specs.map(b => s.buttonWidth(b.label))
  // The columns the actions from `from` up to `to` take side by side
  const span = (from: number, to: number) => widths.slice(from, to).reduce((n, w) => n + w, 0) + Math.max(0, to - from - 1)
  const actionsRow = (key: string, from: number, to: number) => (
    <Box key={key} flexDirection="row" columnGap={1} alignItems="center">
      {buttons.slice(from, to)}
    </Box>
  )
  const statusRow = (header: JSX.Element, to: number) => (
    <Box key="top" flexDirection="row" justifyContent="space-between" alignItems="center">
      {header}
      {actionsRow('actions', 0, to)}
    </Box>
  )
  const count = specs.length

  // The status and every action on one line where the room allows, the status trimmed as far as it
  // takes. Otherwise two lines: the status alone above the actions, or, where the actions are too
  // wide for a line of their own, the status beside the first of them and the rest below.
  const levels = HEADER_LEVELS.map(s.header)
  const oneLine = levels.find(h => h.width + 2 + span(0, count) <= room)
  const stacked = levels.find(h => h.width <= room) ?? levels[HEADER_LEVELS.length - 1]!
  const split = HEADER_LEVELS.flatMap(level => Array.from({ length: count - 1 }, (_, i) => ({ h: levels[level]!, k: i + 1 }))).find(
    ({ h, k }) => h.width + 2 + span(0, k) <= room && span(k, count) <= room,
  )
  const top: JSX.Element[] = oneLine
    ? [statusRow(oneLine.node, count)]
    : span(0, count) <= room
      ? [<Box key="top" flexDirection="column">{stacked.node}{actionsRow('actions', 0, count)}</Box>]
      : split
        ? [<Box key="top" flexDirection="column">{statusRow(split.h.node, split.k)}{actionsRow('more', split.k, count)}</Box>]
        : [<Box key="top" flexDirection="column">{stacked.node}{actionsRow('actions', 0, count)}</Box>]
  const topLines = oneLine ? 1 : 2

  // Every control and the latest break stay; the row of history is the one that gives way when the
  // status and the actions take two lines and the break and the keep-warm row are both there.
  const brk = breakRuns(v, room)
  const lines: JSX.Element[] = [...top, runsRow(el, numbersRuns(v, room), 'numbers')]
  const others = topLines + 1 + (brk ? 1 : 0) + (keepWarm ? 1 : 0)
  if (v.history.length > 0 && others < MAX_LINES) lines.push(s.history(room))
  if (brk) lines.push(runsRow(el, brk, 'break'))
  if (keepWarm) lines.push(keepWarmRow(el, v, a, room, s))
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
    history: room => runsRow(el, terminalHistoryRuns(v.history, room), 'history'),
    closeLabel: null,
    buttonWidth: label => label.length + 4,
    pickerChrome: 4,
  })
}

export function desktopPane(el: ElementTable<'desktop'>, v: View, columns: number, a: PaneActions) {
  // Box, Text, Button and Select draw the same on both surfaces.
  return body(el as unknown as Common, v, a, columns, {
    // The desktop's padding is not measured (the app is not driven here), so it keeps the wider margin.
    inset: 6,
    header: level => {
      const h = desktopHeader(el, v, level)
      // Pixels turned into the columns the room is measured in
      return { node: h.node, width: h.width / 7.5 }
    },
    history: () => desktopHistory(el, v.history, columns),
    closeLabel: 'Close',
    buttonWidth: label => (label.length * 7.2 + 30) / 7.5,
    pickerChrome: 12,
  })
}
