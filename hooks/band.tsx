import type { ElementTable } from 'claude-code'

import type { Req } from '../types'
import { fmtApprox, fmtClock, fmtLocalTime, fmtPct, fmtTokens } from './format'
import { flowRows, wrapWords } from './layout'
import { hitRate, lastRequest, pingsItems, rewriteCost, sessionHitRate, stateTone, stateWord, ttlLabel, type Tone, type View } from './view'

// Everything Cache Maxxer shows lives in the band above the prompt: one line by default, at the
// bottom by the prompt, with the session's detail above it once opened and the keep-warm choices
// above it whenever keep warm is on. This file draws it in the terminal; desktop.tsx in the app.

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

const colorProps = (tone: Tone) => {
  const key = THEME[tone]
  return key === null ? {} : { color: key }
}

const fillProps = (tone: Tone) => ({ backgroundColor: THEME[tone] ?? 'text' })

export type Actions = {
  toggleKeepWarm: () => void
  warmNow: () => void
  compact: () => void
  toggleExpanded: () => void
  // Tucks the Desktop band away to a small chip, and brings it back
  hide: () => void
  show: () => void
  // Opens a keep-warm choice's options, or closes them if that one is open
  togglePicker: (which: 'lead' | 'cap') => void
  setLead: (value: string) => void
  setIdleCap: (value: string) => void
}

// A run with `fill` is drawn as cells of solid color, its text only spaces.
type Run = { text: string; tone: Tone; bold?: boolean; fill?: boolean }

const muted = (text: string): Run => ({ text, tone: 'muted' })
const fig = (text: string, bold?: boolean): Run => ({ text, tone: 'fg', ...(bold ? { bold } : {}) })

const runsLength = (runs: readonly Run[]) => runs.reduce((n, r) => n + r.text.length, 0)

// Neighbouring runs of one tone draw as one piece of text.
function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    const prev = out[out.length - 1]
    if (prev && prev.tone === r.tone && prev.bold === r.bold && prev.fill === r.fill) prev.text += r.text
    else out.push({ ...r })
  }
  return out
}

// ---- The controls ----

export type ButtonSpec = { key: string; label: string; isPrimary: boolean; isDim?: boolean; hotkey?: string; press: () => void }

// The buttons on the first line: keep warm, the action the state calls for, and the one that opens
// or closes the detail. Each has a key that presses it while the band has the focus.
export function mainButtons(v: View, a: Actions): ButtonSpec[] {
  const hasCache = v.cache.startedAt > 0
  const specs: ButtonSpec[] = [
    { key: 'keep', label: `Keep warm: ${v.settings.keepWarm ? 'on' : 'off'}`, isPrimary: v.settings.keepWarm, hotkey: 'k', press: a.toggleKeepWarm },
  ]
  // A ping takes a few seconds to come back; meanwhile the button says it is on its way.
  if (hasCache && !v.isExpired) specs.push({ key: 'warm', label: v.isPinging ? 'Warming…' : 'Warm now', isPrimary: false, isDim: v.isPinging, hotkey: 'w', press: a.warmNow })
  if (hasCache && v.isExpired) specs.push({ key: 'compact', label: 'Compact', isPrimary: false, hotkey: 'c', press: a.compact })
  // The detail opens above the first line, so the arrows point up to open and down to close.
  specs.push({ key: 'more', label: v.expanded ? 'Less ▾' : 'More ▴', isPrimary: false, hotkey: 'm', press: a.toggleExpanded })
  return specs
}

// ---- The first line: the countdown, how long the cache lives and how well it hit ----

// One piece of the first line. A piece with `alts` has shorter wordings, longest first; one marked
// `isShrunkLast` gives up room only once every wording has. No piece is ever left out: a band too
// narrow for them all beside the buttons gives them rows of their own.
type Item = { key: string; runs: Run[]; alts?: Run[][]; isShrunkLast?: boolean }

const TRACK = 10
const SHORT_TRACK = 6

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
  // A solid bar: the life left in the state's color over a dim track. Colored cells, not block
  // characters, so no font draws seams between them. It shortens only to keep the line whole.
  const bar = (cells: number): Run[] => {
    const filled = Math.round(Math.min(1, Math.max(0, v.leftMs / v.ttl.ms)) * cells)
    return [{ text: ' '.repeat(filled), tone, fill: true }, { text: ' '.repeat(cells - filled), tone: 'muted', fill: true }]
  }
  items.push({ key: 'track', runs: bar(TRACK), alts: [bar(SHORT_TRACK)], isShrunkLast: true })
  if (tone !== 'warm') items.push({ key: 'word', runs: [{ text: stateWord(v).toLowerCase(), tone }] })
  const isHour = v.ttl.ms >= 600_000
  items.push({ key: 'length', runs: [muted(ttlLabel(v))], alts: [[muted(v.ttl.isKnown ? (isHour ? '1h cache' : '5m cache') : '1h, assumed')]] })
  const last = lastRequest(v)
  if (last) items.push({ key: 'hit', runs: hitRuns(v, last), alts: [hitRuns(v, last, true)] })
  return items
}

// The last request's hit rate and the session's, side by side: "hit 99.94% last request · 94.12%
// this session", or in a narrow band "request 99.94% · session 94.12%".
function hitRuns(v: View, last: Req, isShort = false): Run[] {
  const now = fig(fmtPct(hitRate(last)), true)
  const session = fig(fmtPct(sessionHitRate(v)), true)
  return isShort
    ? [muted('request '), now, muted(' · session '), session]
    : [muted('hit '), now, muted(' last request · '), session, muted(' this session')]
}

const ITEM_GAP = 2
const itemsWidth = (items: readonly Item[]) => items.reduce((n, it) => n + runsLength(it.runs), 0) + ITEM_GAP * Math.max(0, items.length - 1)

// The first line in `room`, every piece in the fullest wording that fits: the full wordings, else
// pieces shortened in order, left to right, the bar last, until the line fits. Null when even the
// shortest wordings do not fit.
function fitItems(items: readonly Item[], room: number): Item[] | null {
  const out = [...items]
  const order = [...out.keys()].sort((x, y) => Number(Boolean(out[x]!.isShrunkLast)) - Number(Boolean(out[y]!.isShrunkLast)) || x - y)
  for (const i of order) {
    if (itemsWidth(out) <= room) break
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
      {...(b.isDim ? { dimColor: true } : {})}
    />
  )
}

// Runs side by side, each in its own tone.
function textEl(el: Common, runs: readonly Run[], key: string) {
  const { Box, Text } = el
  return (
    <Box key={key} flexDirection="row">
      {mergeRuns(runs).map((r, i) => (
        <Text key={`${key}-${i}`} {...(r.fill ? fillProps(r.tone) : colorProps(r.tone))} {...(r.bold ? { bold: true } : {})}>
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
const LABEL_COLUMN = 18
const MIN_LABELLED = 56

type Section = { key: string; label: string; cells: (room: number) => Cell[] }

// Narrow, the values sit under their label, indented this much.
const INDENT = 2

function sectionRows(el: Common, s: Section, columns: number): JSX.Element[] {
  const isBeside = columns >= MIN_LABELLED
  const room = isBeside ? columns - LABEL_COLUMN : columns - INDENT
  const rows = flowCells(s.cells(room), room)
  const out: JSX.Element[] = []
  if (!isBeside) out.push(textEl(el, [{ text: s.label, tone: 'muted', bold: true }], `${s.key}-heading`))
  // Beside: the label on the section's first row, an empty column under it. Under: an indent.
  const labelOf = (i: number): Label => (isBeside ? { text: i === 0 ? s.label : '', width: LABEL_COLUMN } : { text: '', width: INDENT })
  rows.forEach((row, i) => out.push(cellRow(el, row, `${s.key}${i}`, labelOf(i))))
  return out
}

// ---- The session's numbers ----

function sessionCells(v: View): Cell[] {
  const t = v.totals
  if (t.requests === 0) return [textCell('none', [muted('No requests yet')])]
  const cells = [
    textCell('rate', [fig(fmtPct(sessionHitRate(v)), true), muted(' hit')]),
    textCell('requests', [fig(String(t.requests)), muted(t.requests === 1 ? ' request' : ' requests')]),
    textCell('read', [fig(fmtTokens(t.read)), muted(' read')]),
    textCell('written', [fig(fmtTokens(t.written)), muted(' written')]),
  ]
  // The write cost, then what the cache saved, the session's key figure, last.
  if (t.isPriced) cells.push(textCell('writes', [muted('write cost '), fig(fmtApprox(t.writeCostUsd))]), textCell('saved', [muted('saved '), fig(fmtApprox(t.savingsUsd))]))
  return cells
}

// ---- The last requests: a dot each, a red mark where the cache read dropped ----

const RECENT = 10

function recentCells(v: View, room: number): Cell[] {
  const shown = v.history.slice(-RECENT)
  const marks = shown.flatMap((r, i): Run[] => [...(i > 0 ? [muted(' ')] : []), r.isBreak ? { text: '▲', tone: 'danger' } : { text: '●', tone: 'warm' }])
  const breaks = shown.filter(r => r.isBreak).length
  const words = breaks === 0 ? 'no cache break' : breaks === 1 ? '1 cache break' : `${breaks} cache breaks`
  return [textCell('marks', marks), ...textCells('recent-key', [muted(words)], room)]
}

// The section's label counts the requests its dots stand for.
const recentLabel = (v: View) => {
  const n = Math.min(RECENT, v.history.length)
  return n === 1 ? 'Last request' : `Last ${n} requests`
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

// ---- Keep warm: its two choices and what it has done ----

type Option = { value: string; label: string }

export const OPTIONS: Record<'lead' | 'cap', readonly Option[]> = {
  lead: [
    { value: 'auto', label: 'automatic' },
    { value: '1m', label: '1 minute' },
    { value: '2m', label: '2 minutes' },
    { value: '4m', label: '4 minutes' },
    { value: '8m', label: '8 minutes' },
  ],
  cap: [
    { value: '1h', label: '1 hour' },
    { value: '3h', label: '3 hours' },
    { value: '8h', label: '8 hours' },
    { value: 'none', label: 'never' },
  ],
}

// What each choice is called, in full and, for a band where the full names take a row more, short.
type Names = Record<'lead' | 'cap', string>
export const FULL_NAMES: Names = { lead: 'Warm before expiry', cap: 'Stop after idle' }
const SHORT_NAMES: Names = { lead: 'Warm', cap: 'Stop' }
const CHOICE_HINT = 'click to change'

export const currentOf = (v: View, which: 'lead' | 'cap') => (which === 'lead' ? v.settings.lead : v.settings.idleCap)

// The two choices as buttons that open their options, then whether keep warm has paused. Each ping
// already gets its own notice, so the running count waits for the detail.
function choiceCells(v: View, a: Actions, s: Surface, names: Names, room: number): Cell[] {
  const choice = (which: 'lead' | 'cap'): Cell => {
    const label = `${names[which]}: ${OPTIONS[which].find(o => o.value === currentOf(v, which))?.label ?? ''} ${v.picker === which ? '▾' : '▴'}`
    return { key: which, width: s.buttonWidth(label), button: { key: which, label, isPrimary: false, press: () => a.togglePicker(which) } }
  }
  const items = v.expanded ? pingsItems(v) : []
  if (v.paused !== '') items.push(names === FULL_NAMES ? `Paused: you have been idle for ${v.paused}.` : `Paused: idle for ${v.paused}.`)
  return [choice('lead'), choice('cap'), ...items.flatMap((text, i) => textCells(`ping${i}`, [muted(text)], room))]
}

function keepWarmCells(v: View, a: Actions, s: Surface, room: number): Cell[] {
  // The full names unless the short ones save a row.
  const full = choiceCells(v, a, s, FULL_NAMES, room)
  const short = choiceCells(v, a, s, SHORT_NAMES, room)
  const cost = (cells: Cell[]) => (cells.some(c => c.width > room) ? 1000 : 0) + flowCells(cells, room).length
  const cells = cost(short) < cost(full) ? short : full
  // The hint rides on the last row only where it fits, so it never costs a row, and goes while a
  // choice is open.
  const hint = textCell('hint', [muted(CHOICE_HINT)])
  if (v.picker !== '') return cells
  return flowCells([...cells, hint], room).length === flowCells(cells, room).length ? [...cells, hint] : cells
}

// The keep-warm section, with an open choice's options listed one per row directly above the button
// that opened them, starting in its column, the current one highlighted. Picking one sets it and
// closes the list; the choice's own button closes it unchanged. It carries no label: it shows only
// while keep warm is on, and its choices say what they are.
function keepWarmRows(el: Common, v: View, a: Actions, s: Surface, columns: number): JSX.Element[] {
  const { Box } = el
  const isBeside = columns >= MIN_LABELLED
  const room = isBeside ? columns - LABEL_COLUMN : columns - INDENT
  const rows = flowCells(keepWarmCells(v, a, s, room), room)
  const blank: Label = { text: '', width: isBeside ? LABEL_COLUMN : INDENT }
  const drawn = rows.map((row, i) => cellRow(el, row, `keepwarm${i}`, blank))
  const out: JSX.Element[] = []
  const which = v.picker
  const at = which === '' ? -1 : rows.findIndex(row => row.some(c => c.key === which))
  if (at < 0) return [...out, ...drawn]
  // Where the open choice starts in its row, in the columns its cells and their gaps take.
  const row = rows[at]!
  let x = 0
  for (let i = 0; row[i]!.key !== which; i++) x += row[i]!.width + gapBetween(row[i]!, row[i + 1]!)
  const choose = which === 'lead' ? a.setLead : a.setIdleCap
  const options = OPTIONS[which].map(o => (
    <Box key={`${which}-option-${o.value}`} flexDirection="row" alignItems="center">
      {labelEl(el, blank, `${which}-option-${o.value}-label`)}
      {x > 0 ? <Box width={x} flexShrink={0} /> : null}
      {buttonEl(el, { key: `${which}:${o.value}`, label: o.label, isPrimary: o.value === currentOf(v, which), press: () => choose(o.value) })}
    </Box>
  ))
  return [...out, ...drawn.slice(0, at), ...options, ...drawn.slice(at)]
}

// ---- The band ----

type Parts = {
  // The first line's status, fitted to a room
  status: (room: number) => { node: JSX.Element; width: number } | null
  // The status on rows of its own, for a band too narrow to hold it beside the buttons
  statusRows: (room: number) => JSX.Element[]
}

const FRAME_COLUMNS = 4

function bandBody(el: Common, v: View, columns: number, a: Actions, s: Surface, p: Parts, rest: JSX.Element) {
  const { Box } = el
  // The band sits in a rounded frame, one cell of padding inside it.
  const room = Math.max(20, columns - FRAME_COLUMNS)
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
  const main: JSX.Element[] = beside
    ? [
        <Box key="top" flexDirection="row" justifyContent="space-between" alignItems="center">
          {beside.node}
          {buttonRow(buttonCells, 'buttons')}
        </Box>,
      ]
    : [...p.statusRows(room), ...flowRows(buttonCells, c => c.width, 2, room).map((row, i) => buttonRow(row, `buttons${i}`))]

  // The first line stays at the bottom, next to the prompt: the detail, the keep-warm row and an open
  // choice's options all open above it.
  const lines: JSX.Element[] = []
  if (v.expanded) {
    lines.push(...sectionRows(el, { key: 'session', label: 'This session', cells: () => sessionCells(v) }, room))
    if (v.history.length > 0) lines.push(...sectionRows(el, { key: 'recent', label: recentLabel(v), cells: r => recentCells(v, r) }, room))
    if (v.breaks.length > 0) lines.push(...sectionRows(el, { key: 'break', label: 'Last break', cells: r => breakCells(v, r) }, room))
  }
  if (v.settings.keepWarm) lines.push(...keepWarmRows(el, v, a, s, room))
  // A blank row keeps the solid bar of the first line clear of the row above it.
  if (lines.length > 0) lines.push(<Box key="above-main" height={1} />)
  lines.push(...main)
  // The frame keeps the band apart from the conversation and from Claude's working lines over it.
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={THEME.muted ?? 'inactive'} paddingX={1}>
        {lines}
      </Box>
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
  }, rest)
}

// ---- Shared with the Desktop band (desktop.tsx) ----

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
