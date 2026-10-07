import type { ElementTable } from 'claude-code'

import type { Req } from '../types'
import { fmtApprox, fmtClock, fmtLocalTime, fmtTokens } from './format'
import { flowRows, wrapWords } from './layout'
import { HISTORY_LIMIT } from './model'
import { hitRate, lastRequest, pingsItems, rewriteCost, sessionHitRate, stateTone, stateWord, ttlLabel, type Tone, type View } from './view'

// Everything Cache Maxxer shows lives in the band above the prompt: one line by default, the
// session's detail under it once opened, and the keep-warm choices whenever keep warm is on.

// The terminal draws in the person's own theme: each tone is a theme key, and plain text keeps the
// terminal's own color.
const THEME: Record<Tone, string | null> = {
  fg: null,
  muted: 'inactive',
  warm: 'success',
  warn: 'warning',
  danger: 'error',
  accent: 'claude',
}

// An SVG cannot name a theme key, so the desktop's drawings use mid tones that read on light and dark.
export const COLORS: Record<Tone, string> = {
  fg: '#8A8A8A',
  muted: '#8A8A8A',
  warm: '#3E9E6E',
  warn: '#D08A1E',
  danger: '#D64545',
  accent: '#D97757',
}

const colorProps = (tone: Tone) => {
  const key = THEME[tone]
  return key === null ? {} : { color: key }
}

export type Actions = {
  toggleKeepWarm: () => void
  warmNow: () => void
  compact: () => void
  toggleExpanded: () => void
  // Opens a keep-warm choice's options, or closes them if that one is open
  togglePicker: (which: 'lead' | 'cap') => void
  setLead: (value: string) => void
  setIdleCap: (value: string) => void
}

type Run = { text: string; tone: Tone; bold?: boolean }

const muted = (text: string): Run => ({ text, tone: 'muted' })
const fig = (text: string, bold?: boolean): Run => ({ text, tone: 'fg', ...(bold ? { bold } : {}) })

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

// ---- The controls ----

export type ButtonSpec = { key: string; label: string; isPrimary: boolean; hotkey?: string; press: () => void }

// The buttons on the first line: keep warm, the action the state calls for, and the one that opens
// or closes the detail. Each has a key that presses it while the band has the focus.
function mainButtons(v: View, a: Actions): ButtonSpec[] {
  const hasCache = v.cache.startedAt > 0
  const specs: ButtonSpec[] = [
    { key: 'keep', label: `Keep warm: ${v.settings.keepWarm ? 'on' : 'off'}`, isPrimary: v.settings.keepWarm, hotkey: 'k', press: a.toggleKeepWarm },
  ]
  if (hasCache && !v.isExpired) specs.push({ key: 'warm', label: 'Warm now', isPrimary: false, hotkey: 'w', press: a.warmNow })
  if (hasCache && v.isExpired) specs.push({ key: 'compact', label: 'Compact', isPrimary: false, hotkey: 'c', press: a.compact })
  specs.push({ key: 'more', label: v.expanded ? 'Less ▴' : 'More ▾', isPrimary: false, hotkey: 'm', press: a.toggleExpanded })
  return specs
}

// ---- The first line: the countdown, how long the cache lives and how well it hit ----

// One piece of the first line. A piece with `alts` has shorter wordings, longest first. No piece is
// ever left out: a band too narrow for them all beside the buttons gives them rows of their own.
type Item = { key: string; runs: Run[]; alts?: Run[][] }

const TRACK = 16

const stateDot = (tone: Tone) => (tone === 'muted' ? '○' : '●')

function statusItems(v: View): Item[] {
  const tone = stateTone(v)
  if (v.cache.startedAt === 0) {
    return [{ key: 'state', runs: [muted('○ '), muted('No cache yet'), muted(' · it starts with your next message')], alts: [[muted('○ No cache yet')]] }]
  }
  if (v.isExpired) {
    const cost = rewriteCost(v)
    const price = cost === null ? '' : ` (${fmtApprox(cost)})`
    const tokens = v.cache.ctx > 0 ? fmtTokens(v.cache.ctx) : 'everything'
    const what = v.cache.ctx > 0 ? `${tokens} tokens` : 'the whole context'
    return [
      { key: 'state', runs: [muted('○ '), { text: 'expired', tone: 'muted', bold: true }] },
      {
        key: 'rewrite',
        runs: [muted(`next message re-writes ${what}${price}`)],
        alts: [[muted(`next message re-writes ${tokens}${price}`)], [muted(`re-writes ${tokens}${price}`)]],
      },
    ]
  }
  const items: Item[] = [{ key: 'state', runs: [{ text: `${stateDot(tone)} `, tone }, { text: fmtClock(v.leftMs, v.ttl.ms), tone, bold: true }] }]
  const filled = Math.round(Math.min(1, Math.max(0, v.leftMs / v.ttl.ms)) * TRACK)
  items.push({ key: 'track', runs: [{ text: '━'.repeat(filled), tone }, muted('─'.repeat(TRACK - filled))] })
  if (tone !== 'warm') items.push({ key: 'word', runs: [{ text: stateWord(v).toLowerCase(), tone }] })
  const isHour = v.ttl.ms >= 600_000
  items.push(
    v.ttl.isKnown
      ? { key: 'length', runs: [muted(ttlLabel(v))], alts: [[muted(isHour ? '1h cache' : '5m cache')]] }
      : { key: 'length', runs: [muted('1 hour cache, assumed')], alts: [[muted('1h, assumed')]] },
  )
  const last = lastRequest(v)
  if (last) items.push({ key: 'hit', runs: [fig(`${hitRate(last)}%`, true), muted(' hit')] })
  return items
}

const ITEM_GAP = 2
const itemsWidth = (items: readonly Item[]) => items.reduce((n, it) => n + runsLength(it.runs), 0) + ITEM_GAP * Math.max(0, items.length - 1)

// The first line in `room`, every piece in the fullest wording that fits: the full wordings, else
// the widest pieces shortened first. Null when even the shortest wordings do not fit.
function fitItems(items: readonly Item[], room: number): Item[] | null {
  const out = [...items]
  for (let i = 0; i < out.length && itemsWidth(out) > room; i++) {
    const it = out[i]!
    for (const runs of it.alts ?? []) {
      out[i] = { ...it, runs }
      if (itemsWidth(out) <= room) break
    }
  }
  return itemsWidth(out) <= room ? out : null
}

// ---- The detail rows ----

// One thing on a detail row: text, or a button.
type Cell = { key: string; width: number; runs?: Run[]; button?: ButtonSpec }

const textCell = (key: string, runs: Run[]): Cell => ({ key, width: runsLength(runs), runs })

// Text wider than the room is cut at its spaces into cells of a row each.
function textCells(key: string, runs: Run[], room: number): Cell[] {
  if (runsLength(runs) <= room) return [textCell(key, runs)]
  const tone = runs[0]?.tone ?? 'muted'
  return wrapWords(runs.map(r => r.text).join(''), room).map((line, i) => textCell(`${key}-${i}`, [{ text: line, tone }]))
}

const SEP = ' · '
// Two texts side by side are joined by a dot; a button keeps two spaces from what is beside it.
const gapBetween = (a: Cell, b: Cell) => (a.runs && b.runs ? SEP.length : 2)

function flowCells(cells: readonly Cell[], room: number): Cell[][] {
  const rows: Cell[][] = []
  let used = 0
  for (const c of cells) {
    const row = rows[rows.length - 1]
    const gap = row ? gapBetween(row[row.length - 1]!, c) : 0
    if (row && used + gap + c.width <= room) {
      row.push(c)
      used += gap + c.width
    } else {
      rows.push([c])
      used = c.width
    }
  }
  return rows
}

// What one surface draws differently: how wide a button is, in the columns the room is measured in.
type Surface = { buttonWidth: (label: string) => number }

// The common part of both surfaces' element tables; the rows use nothing else.
type Common = ElementTable<'terminal'>

function buttonEl(el: Common, b: ButtonSpec) {
  const { Button } = el
  return (
    <Button
      key={b.key}
      label={b.label}
      onPress={b.press}
      {...(b.hotkey ? { hotkey: b.hotkey } : {})}
      {...(b.isPrimary ? { variant: 'primary' as const } : {})}
    />
  )
}

// Runs side by side, each in its own tone.
function textEl(el: Common, runs: readonly Run[], key: string) {
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

// A section's label in a column of fixed width, so the values of every section start in one place.
type Label = { text: string; width: number }

function labelEl(el: Common, label: Label, key: string) {
  const { Box, Text } = el
  return (
    <Box key={key} width={label.width} flexShrink={0}>
      <Text {...colorProps('muted')}>{label.text}</Text>
    </Box>
  )
}

// One drawn row: its cells left to right, texts joined by a dot, buttons two spaces from their
// neighbours, after the section's label column (`label` null: no column).
function cellRow(el: Common, cells: readonly Cell[], key: string, label: Label | null = null) {
  const { Box } = el
  const parts: JSX.Element[] = label === null ? [] : [labelEl(el, label, `${key}-label`)]
  let text: Run[] = []
  const flush = (k: string) => {
    if (text.length > 0) parts.push(textEl(el, text, k))
    text = []
  }
  cells.forEach((c, i) => {
    const prev = cells[i - 1]
    if (prev) text.push(muted(prev.runs && c.runs ? SEP : '  '))
    if (c.button) {
      flush(`${key}-t${i}`)
      parts.push(buttonEl(el, c.button))
    } else {
      text.push(...c.runs!)
    }
  })
  flush(`${key}-end`)
  return (
    <Box key={key} flexDirection="row" alignItems="center">
      {parts}
    </Box>
  )
}

// The rows of one labelled section: the label in a column of its own where the band is wide enough,
// else on a line above its values.
const LABEL_COLUMN = 14
const MIN_LABELLED = 52

type Section = { key: string; label: string; cells: (room: number) => Cell[]; extra?: (room: number) => JSX.Element[] }

// Narrow, the values sit under their label, indented this much.
const INDENT = 2

function sectionRows(el: Common, s: Section, columns: number): JSX.Element[] {
  const { Box } = el
  const isBeside = columns >= MIN_LABELLED
  const room = isBeside ? columns - LABEL_COLUMN : columns - INDENT
  const rows = flowCells(s.cells(room), room)
  const out: JSX.Element[] = []
  if (!isBeside) out.push(textEl(el, [{ text: s.label, tone: 'muted', bold: true }], `${s.key}-heading`))
  // Beside: the label on the section's first row, an empty column under it. Under: an indent.
  const labelOf = (i: number): Label => (isBeside ? { text: i === 0 ? s.label : '', width: LABEL_COLUMN } : { text: '', width: INDENT })
  rows.forEach((row, i) => out.push(cellRow(el, row, `${s.key}${i}`, labelOf(i))))
  for (const [i, node] of (s.extra?.(room) ?? []).entries()) {
    out.push(
      <Box key={`${s.key}-x${i}`} flexDirection="row" alignItems="center">
        {labelEl(el, labelOf(rows.length + i), `${s.key}-xl${i}`)}
        {node}
      </Box>,
    )
  }
  return out
}

// ---- The session's numbers ----

function sessionCells(v: View): Cell[] {
  const t = v.totals
  if (t.requests === 0) return [textCell('none', [muted('No requests yet')])]
  const cells = [
    textCell('rate', [fig(`${sessionHitRate(v)}%`, true), muted(' hit')]),
    textCell('requests', [fig(String(t.requests)), muted(t.requests === 1 ? ' request' : ' requests')]),
    textCell('read', [fig(fmtTokens(t.read)), muted(' read')]),
    textCell('written', [fig(fmtTokens(t.written)), muted(' written')]),
    textCell('uncached', [fig(fmtTokens(t.uncached)), muted(' uncached')]),
  ]
  if (v.cache.ctx > 0) cells.push(textCell('ctx', [fig(fmtTokens(v.cache.ctx)), muted(' context')]))
  if (t.isPriced) cells.push(textCell('saved', [muted('saved '), fig(fmtApprox(t.savingsUsd))]), textCell('writes', [muted('writes '), fig(fmtApprox(t.writeCostUsd))]))
  return cells
}

// ---- The latest break ----

function breakCells(v: View, room: number): Cell[] {
  const latest = v.breaks[v.breaks.length - 1]
  if (!latest) return []
  const more = v.breaks.length - 1
  return [
    textCell('at', [fig(fmtLocalTime(latest.at))]),
    textCell('rewritten', [fig(fmtTokens(latest.written)), muted(' re-written')]),
    ...(latest.costUsd !== null ? [textCell('cost', [fig(fmtApprox(latest.costUsd))])] : []),
    ...textCells('cause', [muted(latest.cause)], room),
    ...(more > 0 ? [textCell('more', [muted(`and ${more} more`)])] : []),
  ]
}

// ---- The last requests, newest on the right ----

const tokensOf = (r: Req) => r.read + r.written + r.uncached
const PART_TONES: readonly Tone[] = ['warm', 'warn', 'muted']
const EIGHTHS = ' ▁▂▃▄▅▆▇█'
const LEGEND: readonly Run[][] = [
  [{ text: '■ ', tone: 'warm' }, muted('read')],
  [{ text: '■ ', tone: 'warn' }, muted('written')],
  [muted('■ uncached')],
  [{ text: '▲ ', tone: 'danger' }, muted('break')],
]
const MIN_BARS = 8

// One cell per request, as tall as the request is big next to the others, in the color of its
// largest part; a break is a red mark. The legend follows on the row where it fits, else on rows of its own.
function historyCells(history: readonly Req[], room: number): Cell[] {
  const legend = LEGEND.map((runs, i) => textCell(`legend${i}`, runs))
  const legendWidth = legend.reduce((n, c) => n + c.width, 0) + 2 * (legend.length - 1)
  const label = (n: number) => ` last ${n}`
  const inline = room - label(HISTORY_LIMIT).length - 3 - legendWidth
  const cells = Math.max(1, Math.min(history.length, HISTORY_LIMIT, inline >= Math.min(MIN_BARS, history.length) ? inline : room - label(HISTORY_LIMIT).length))
  const shown = history.slice(-cells)
  const max = Math.max(1, ...shown.map(tokensOf))
  const bars: Run[] = shown.map(r => {
    if (r.isBreak) return { text: '▲', tone: 'danger' as Tone }
    const parts = [r.read, r.written, r.uncached]
    const part = parts.indexOf(Math.max(...parts))
    const level = Math.min(8, Math.max(1, Math.ceil((tokensOf(r) / max) * 8)))
    return { text: EIGHTHS[level]!, tone: PART_TONES[part]! }
  })
  // The legend's items sit two spaces apart: they are one key, not separate figures.
  const key = textCell('legend', LEGEND.flatMap((runs, i) => (i === 0 ? [...runs] : [muted('  '), ...runs])))
  return [textCell('bars', [...bars, muted(label(shown.length))]), ...(key.width <= room ? [key] : legend)]
}

// ---- Keep warm: its two choices and what it has done, or one choice's options ----

type Option = { value: string; label: string }
type Choices = { lead: readonly Option[]; cap: readonly Option[] }

const FULL_CHOICES: Choices = {
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

// The same choices in fewer words, for a band where the full ones take a row more.
const SHORT_CHOICES: Choices = {
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

const OPEN_CHOICES: Record<'lead' | 'cap', { ask: string; options: readonly Option[] }> = {
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

const CHOICE_NAMES = { lead: 'Ping', cap: 'Stop' } as const
const CHOICE_HINT = 'click to change'

function closedCells(v: View, a: Actions, s: Surface, choices: Choices, room: number): Cell[] {
  const choice = (which: 'lead' | 'cap'): Cell => {
    const current = which === 'lead' ? v.settings.lead : v.settings.idleCap
    const label = `${CHOICE_NAMES[which]}: ${choices[which].find(o => o.value === current)?.label ?? ''} ▾`
    return { key: which, width: s.buttonWidth(label), button: { key: which, label, isPrimary: false, press: () => a.togglePicker(which) } }
  }
  const isFull = choices === FULL_CHOICES
  const items = pingsItems(v.pings)
  if (v.paused !== '') items.push(isFull ? `Paused: you have been idle for ${v.paused}.` : `Paused: idle for ${v.paused}.`)
  return [choice('lead'), choice('cap'), ...items.flatMap((text, i) => textCells(`ping${i}`, [muted(text)], room))]
}

function openCells(v: View, a: Actions, s: Surface, which: 'lead' | 'cap', room: number): Cell[] {
  const list = OPEN_CHOICES[which]
  const current = which === 'lead' ? v.settings.lead : v.settings.idleCap
  const choose = which === 'lead' ? a.setLead : a.setIdleCap
  const button = (b: ButtonSpec): Cell => ({ key: b.key, width: s.buttonWidth(b.label), button: b })
  return [
    ...textCells('ask', [fig(list.ask)], room),
    ...list.options.map(o => button({ key: `${which}:${o.value}`, label: o.label, isPrimary: o.value === current, press: () => choose(o.value) })),
    button({ key: 'picker-cancel', label: 'Cancel', isPrimary: false, press: () => a.togglePicker(which) }),
  ]
}

function keepWarmCells(v: View, a: Actions, s: Surface, room: number): Cell[] {
  if (v.picker !== '') return openCells(v, a, s, v.picker, room)
  // The full wording unless the short one saves a row.
  const full = closedCells(v, a, s, FULL_CHOICES, room)
  const short = closedCells(v, a, s, SHORT_CHOICES, room)
  const cost = (cells: Cell[]) => (cells.some(c => c.width > room) ? 1000 : 0) + flowCells(cells, room).length
  const cells = cost(short) < cost(full) ? short : full
  // The hint rides on the last row only where it fits, so it never costs a row.
  const hint = textCell('hint', [muted(CHOICE_HINT)])
  return flowCells([...cells, hint], room).length === flowCells(cells, room).length ? [...cells, hint] : cells
}

// ---- The band ----

type Parts = {
  // The first line's status, fitted to a room
  status: (room: number) => { node: JSX.Element; width: number } | null
  // The status on rows of its own, for a band too narrow to hold it beside the buttons
  statusRows: (room: number) => JSX.Element[]
  history: (v: View, room: number) => { cells: Cell[]; extra?: JSX.Element[] }
}

function bandBody(el: Common, v: View, columns: number, a: Actions, s: Surface, p: Parts, rest: JSX.Element) {
  const { Box } = el
  const room = Math.max(20, columns)
  const buttons = mainButtons(v, a)
  const buttonCells: Cell[] = buttons.map(b => ({ key: b.key, width: s.buttonWidth(b.label), button: b }))
  const buttonsWidth = buttonCells.reduce((n, c) => n + c.width, 0) + 2 * Math.max(0, buttonCells.length - 1)

  // The status and the buttons on one line where they fit, three columns apart; else the status on
  // its own line or lines, and the buttons under it.
  const beside = p.status(room - buttonsWidth - 3)
  const buttonRow = (row: readonly Cell[], key: string) => (
    <Box key={key} flexDirection="row" columnGap={2} alignItems="center">
      {row.map(c => buttonEl(el, c.button!))}
    </Box>
  )
  const lines: JSX.Element[] = beside
    ? [
        <Box key="top" flexDirection="row" justifyContent="space-between" alignItems="center">
          {beside.node}
          {buttonRow(buttonCells, 'buttons')}
        </Box>,
      ]
    : [...p.statusRows(room), ...flowRows(buttonCells, c => c.width, 2, room).map((row, i) => buttonRow(row, `buttons${i}`))]

  if (v.expanded) {
    lines.push(...sectionRows(el, { key: 'session', label: 'This session', cells: () => sessionCells(v) }, room))
    if (v.history.length > 0) {
      lines.push(
        ...sectionRows(el, { key: 'history', label: 'Requests', cells: r => p.history(v, r).cells, extra: r => p.history(v, r).extra ?? [] }, room),
      )
    }
    if (v.breaks.length > 0) lines.push(...sectionRows(el, { key: 'break', label: 'Last break', cells: r => breakCells(v, r) }, room))
  }
  if (v.settings.keepWarm) lines.push(...sectionRows(el, { key: 'keepwarm', label: 'Keep warm', cells: r => keepWarmCells(v, a, s, r) }, room))
  return (
    <Box flexDirection="column">
      {lines}
      {rest}
    </Box>
  )
}

// ---- Terminal ----

export function terminalBand(el: ElementTable<'terminal'>, v: View, columns: number, a: Actions, rest: JSX.Element) {
  const { Box } = el
  const items = statusItems(v)
  const itemsEl = (list: readonly Item[], key: string) => (
    <Box key={key} flexDirection="row">
      {textEl(el, list.flatMap((it, i) => (i === 0 ? it.runs : [muted(' '.repeat(ITEM_GAP)), ...it.runs])), `${key}-t`)}
    </Box>
  )
  return bandBody(el, v, columns, a, { buttonWidth: label => label.length + 4 }, {
    status: room => {
      const fit = fitItems(items, room)
      return fit ? { node: itemsEl(fit, 'status'), width: itemsWidth(fit) } : null
    },
    // Too narrow for the status beside the buttons: the pieces flow onto rows of their own, each in
    // the fullest wording its row holds, nothing dropped.
    statusRows: room => {
      // One row of its own where the pieces fit it shortened; else as many rows as they need.
      const one = fitItems(items, room)
      if (one) return [itemsEl(one, 'status0')]
      const fitted = items.map(it => {
        if (runsLength(it.runs) <= room || !it.alts) return it
        return { ...it, runs: it.alts.find(r => runsLength(r) <= room) ?? it.alts[it.alts.length - 1]! }
      })
      return flowRows(fitted, it => runsLength(it.runs), ITEM_GAP, room).map((row, i) => itemsEl(row, `status${i}`))
    },
    history: (view, room) => ({ cells: historyCells(view.history, room) }),
  }, rest)
}

// ---- Desktop: the countdown and the history drawn, the rest as text and real buttons ----

const FONT_RATIO = 1 / 12
const CELL_PX = 7.5
const HEADER_HEIGHT = 28

// Text width in pixels, estimated by character class (measured against the system font): an SVG
// cannot measure its own text, and a little too wide is safer than overlapping.
export function textPx(text: string, bold = false): number {
  let w = 0
  for (const c of text) {
    if (/[0-9$~]/.test(c)) w += 0.58
    else if (c === ' ' || /[.:,'|]/.test(c)) w += 0.26
    else if (/[ilj]/.test(c)) w += 0.24
    else if (/[trf]/.test(c)) w += 0.32
    else if (c === 'm') w += 0.75
    else if (c === 'w') w += 0.62
    else if (c === '%') w += 0.8
    else if (c === '·') w += 0.3
    else if (/[MW]/.test(c)) w += 0.85
    else if (/[A-Z]/.test(c)) w += 0.62
    else w += 0.48
  }
  return w * 12 * (bold ? 1.06 : 1) * 1.03
}

const escapeXml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The countdown large in the state's color, a thin track of the entry's life under it, and the
// state and the cache length beside it.
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
  const length = hasCache ? (v.ttl.isKnown ? ttlLabel(v) : '1 hour cache, assumed') : ''
  const afterX = x + bigPx + 12
  const width = Math.ceil(afterX + textPx(word, true) * (13 / 12) * 1.1 + (word ? 10 : 0) + textPx(length) * (13 / 12) * 1.12 + 6)
  const dot =
    tone === 'muted'
      ? `<circle cx="9" cy="13" r="4.2" fill="none" stroke="${color}" stroke-width="1.6"/>`
      : `<circle cx="9" cy="13" r="5" fill="${color}"/>`
  const frac = live ? Math.min(1, Math.max(0, v.leftMs / v.ttl.ms)) : 0
  const track = live
    ? `<rect x="${x}" y="25" width="${Math.ceil(bigPx)}" height="2" rx="1" fill="#8A8A8A" fill-opacity="0.25"/>` +
      `<rect x="${x}" y="25" width="${Math.round(bigPx * frac)}" height="2" rx="1" fill="${color}"/>`
    : ''
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEADER_HEIGHT}" viewBox="0 0 ${width} ${HEADER_HEIGHT}">` +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}</style>' +
    dot +
    `<text x="${x}" y="21" font-size="${size}" font-weight="600" fill="${color}">${escapeXml(big)}</text>` +
    track +
    `<text x="${afterX}" y="19" font-size="13" xml:space="preserve">` +
    (word ? `<tspan font-weight="600" fill="${color}">${word}</tspan><tspan dx="10" fill="${COLORS.muted}">${length}</tspan>` : `<tspan fill="${COLORS.muted}">${length}</tspan>`) +
    '</text></svg>'
  const alt = [big, live ? stateWord(v) : hasCache ? 'no live cache' : '', length].filter(Boolean).join(', ')
  return { node: <Svg key="header" source={source} alt={alt} width={width} height={HEADER_HEIGHT} />, width: width / CELL_PX }
}

const BAR = 5
const BAR_GAP = 2
const STRIP_HEIGHT = 28
const BAR_AREA = 21

// Where each part of a request's bar ends, bottom to top: read, then written, then uncached.
function stack(r: Req, scale: number): number[] {
  const read = Math.round(r.read * scale)
  const written = read + Math.round(r.written * scale)
  return [read, written, Math.max(written + Math.round(r.uncached * scale), 1)]
}

// The desktop keeps the stacked bars, one strip tall, with the legend after them.
function desktopHistory(el: ElementTable<'desktop'>, history: readonly Req[], room: number) {
  const { Svg } = el
  const px = Math.max(160, room * CELL_PX - 230)
  const cells = Math.max(MIN_BARS, Math.min(HISTORY_LIMIT, Math.floor(px / (BAR + BAR_GAP))))
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
      if (to - from > 0) parts.push(`<rect x="${x}" y="${base - to}" width="${BAR}" height="${to - from}" rx="1" fill="${COLORS[tone]}"/>`)
    }
    if (r.isBreak) {
      const cx = x + BAR / 2
      parts.push(`<polygon points="${cx - 3},${STRIP_HEIGHT - 0.5} ${cx + 3},${STRIP_HEIGHT - 0.5} ${cx},${base + 1.5}" fill="${COLORS.danger}"/>`)
    }
  })
  let lx = shown.length * (BAR + BAR_GAP) + 10
  const count = `last ${shown.length}`
  parts.push(`<text x="${lx}" y="${base - 6}" font-size="11" fill="${COLORS.muted}">${count}</text>`)
  lx += textPx(count) * (11 / 12) + 14
  for (const [name, tone] of [['read', 'warm'], ['written', 'warn'], ['uncached', 'muted'], ['break', 'danger']] as const) {
    parts.push(`<circle cx="${lx + 4}" cy="${base - 9.5}" r="3.5" fill="${COLORS[tone]}"/><text x="${lx + 12}" y="${base - 6}" font-size="11" fill="${COLORS.muted}">${name}</text>`)
    lx += 12 + textPx(name) * (11 / 12) + 16
  }
  const width = Math.ceil(lx)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${STRIP_HEIGHT}" viewBox="0 0 ${width} ${STRIP_HEIGHT}">` +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}</style>' +
    parts.join('') +
    '</svg>'
  const alt = `Tokens per request for the last ${shown.length} requests, newest on the right: read, written and uncached, breaks marked.`
  return <Svg key="history-strip" source={source} alt={alt} width={width} height={STRIP_HEIGHT} />
}

export function desktopBand(el: ElementTable<'desktop'>, v: View, columns: number, a: Actions, rest: JSX.Element) {
  // Box, Text and Button draw the same on both surfaces; only the drawings differ.
  const common = el as unknown as Common
  const header = () => {
    const head = desktopHeader(el, v)
    const last = lastRequest(v)
    const hit = last && !v.isExpired ? [fig(`${hitRate(last)}%`, true), muted(' hit')] : []
    const rewrite = v.isExpired ? statusItems(v).find(it => it.key === 'rewrite')?.runs ?? [] : []
    const extra = [...hit, ...rewrite]
    const { Box } = el
    const node = (
      <Box key="status" flexDirection="row" columnGap={2} alignItems="center">
        {head.node}
        {extra.length > 0 ? textEl(common, extra, 'status-text') : null}
      </Box>
    )
    return { node, width: head.width + 2 + runsLength(extra) }
  }
  return bandBody(common, v, columns, a, { buttonWidth: label => (label.length * 7.2 + 30) / CELL_PX }, {
    status: room => {
      const status = header()
      return status.width <= room ? status : null
    },
    statusRows: () => [header().node],
    history: (view, room) => ({ cells: [], extra: [desktopHistory(el, view.history, room)] }),
  }, rest)
}
