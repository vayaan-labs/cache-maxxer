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

const LEAD_OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: '1m', label: '1 minute' },
  { value: '2m', label: '2 minutes' },
  { value: '4m', label: '4 minutes' },
  { value: '8m', label: '8 minutes' },
]
const CAP_OPTIONS = [
  { value: '1h', label: '1 hour' },
  { value: '3h', label: '3 hours' },
  { value: '8h', label: '8 hours' },
  { value: 'none', label: 'No cap' },
]

const PING_SENTENCE = 'A ping is one short request that reads the cached context and resets its timer.'
const LABEL_COLUMNS = 24

// ---- The chart of the last requests: read, written and uncached tokens, newest on the right ----

const tokensOf = (r: Req) => r.read + r.written + r.uncached
const SEGMENT_TONES: readonly Tone[] = ['warm', 'warn', 'muted']

// Where each part of a request's bar ends, bottom to top: read, then written, then uncached.
function stack(r: Req, scale: number): number[] {
  const read = Math.round(r.read * scale)
  const written = read + Math.round(r.written * scale)
  const total = Math.max(written + Math.round(r.uncached * scale), 1)
  return [read, written, total]
}

const TERMINAL_CHART_ROWS = 6
const EIGHTHS = ' ▁▂▃▄▅▆▇█'

function terminalChart(el: ElementTable<'terminal'>, history: readonly Req[], columns: number) {
  const { Box, Text } = el
  const shown = history.slice(-Math.max(8, Math.min(HISTORY_LIMIT, columns - 2)))
  const max = Math.max(1, ...shown.map(tokensOf))
  const scale = (TERMINAL_CHART_ROWS * 8) / max
  const stacks = shown.map(r => stack(r, scale))
  const rows: { text: string; tone: Tone }[][] = []
  for (let row = TERMINAL_CHART_ROWS - 1; row >= 0; row--) {
    const cells = stacks.map(ends => {
      const filled = ends[2]! - row * 8
      if (filled <= 0) return { text: ' ', tone: 'muted' as Tone }
      const centre = Math.min(row * 8 + 4, ends[2]! - 1)
      const part = ends.findIndex(end => centre < end)
      return { text: filled >= 8 ? '█' : EIGHTHS[filled]!, tone: SEGMENT_TONES[Math.max(part, 0)]! }
    })
    rows.push(mergeRuns(cells))
  }
  rows.push(mergeRuns(shown.map(r => ({ text: r.isBreak ? '▲' : ' ', tone: 'danger' as Tone }))))
  return (
    <Box flexDirection="column">
      {rows.map((runs, i) => (
        <Box key={`chart${i}`} flexDirection="row">
          {runs.map((r, k) => (
            <Text key={`c${i}-${k}`} {...colorProps(r.tone)}>
              {r.text}
            </Text>
          ))}
        </Box>
      ))}
      <Box flexDirection="row">
        <Text color={COLORS.warm}>■ </Text>
        <Text color={COLORS.muted}>read  </Text>
        <Text color={COLORS.warn}>■ </Text>
        <Text color={COLORS.muted}>written  </Text>
        <Text color={COLORS.muted}>■ uncached  </Text>
        <Text color={COLORS.danger}>▲ </Text>
        <Text color={COLORS.muted}>break</Text>
      </Box>
    </Box>
  )
}

function mergeRuns(cells: { text: string; tone: Tone }[]) {
  const runs: { text: string; tone: Tone }[] = []
  for (const c of cells) {
    const prev = runs[runs.length - 1]
    if (prev && prev.tone === c.tone) prev.text += c.text
    else runs.push({ ...c })
  }
  return runs
}

const CHART_BAR = 8
const CHART_GAP = 3
const CHART_HEIGHT = 100

function desktopChart(el: ElementTable<'desktop'>, history: readonly Req[]) {
  const { Svg } = el
  const max = Math.max(1, ...history.map(tokensOf))
  const scale = CHART_HEIGHT / max
  const width = HISTORY_LIMIT * (CHART_BAR + CHART_GAP)
  const offset = (HISTORY_LIMIT - history.length) * (CHART_BAR + CHART_GAP)
  const parts: string[] = [
    `<line x1="0" y1="${CHART_HEIGHT + 4}" x2="${width}" y2="${CHART_HEIGHT + 4}" stroke="#8A8A8A" stroke-opacity="0.35"/>`,
  ]
  history.forEach((r, i) => {
    const x = offset + i * (CHART_BAR + CHART_GAP)
    const ends = stack(r, scale)
    const parts3: [number, number, Tone][] = [
      [0, ends[0]!, 'warm'],
      [ends[0]!, ends[1]!, 'warn'],
      [ends[1]!, ends[2]!, 'muted'],
    ]
    for (const [from, to, tone] of parts3) {
      if (to - from <= 0) continue
      parts.push(`<rect x="${x}" y="${CHART_HEIGHT + 2 - to}" width="${CHART_BAR}" height="${to - from}" rx="1.5" fill="${COLORS[tone]}"/>`)
    }
    if (r.isBreak) parts.push(`<circle cx="${x + CHART_BAR / 2}" cy="${CHART_HEIGHT + 13}" r="2.5" fill="${COLORS.danger}"/>`)
  })
  const legend = [
    ['read', 'warm'],
    ['written', 'warn'],
    ['uncached', 'muted'],
    ['break', 'danger'],
  ] as const
  let lx = 0
  const legendParts = legend.map(([name, tone]) => {
    const part = `<circle cx="${lx + 4}" cy="${CHART_HEIGHT + 30}" r="4" fill="${COLORS[tone]}"/><text x="${lx + 13}" y="${CHART_HEIGHT + 34}" font-size="11" fill="#8A8A8A">${name}</text>`
    lx += 28 + textPx(name) * 0.92
    return part
  })
  const height = CHART_HEIGHT + 40
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}</style>' +
    parts.join('') +
    legendParts.join('') +
    '</svg>'
  const alt = `Tokens per request for the last ${history.length} requests, newest on the right: read, written and uncached.`
  return <Svg source={source} alt={alt} width={width} height={height} />
}

// ---- The header: the countdown large, the cache length and the state word ----

function terminalHeader(el: ElementTable<'terminal'>, v: View) {
  const { Box, Text } = el
  const tone = stateTone(v)
  const color = COLORS[tone]
  return (
    <Box flexDirection="row" columnGap={2}>
      <Text bold color={color}>
        {v.cache.startedAt === 0 ? '--:--' : v.isExpired ? 'expired' : fmtClock(v.leftMs, v.ttl.ms)}
      </Text>
      <Text color={COLORS.muted}>{ttlLabel(v)}</Text>
      <Text color={color}>{v.cache.startedAt === 0 ? 'No cache yet' : stateWord(v)}</Text>
    </Box>
  )
}

function desktopHeader(el: ElementTable<'desktop'>, v: View) {
  const { Svg } = el
  const tone = stateTone(v)
  const hasCache = v.cache.startedAt > 0
  const big = !hasCache ? '--:--' : v.isExpired ? 'expired' : fmtClock(v.leftMs, v.ttl.ms)
  const size = v.isExpired ? 28 : 34
  const bigPx = big.length * size * 0.6 + 8
  const word = !hasCache ? 'No cache yet' : stateWord(v)
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="48" viewBox="0 0 340 48">' +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}</style>' +
    `<text x="2" y="38" font-size="${size}" font-weight="600" fill="${COLORS[tone]}">${big}</text>` +
    `<text x="${bigPx + 8}" y="22" font-size="13" font-weight="600" fill="${COLORS[tone]}">${word}</text>` +
    `<text x="${bigPx + 8}" y="40" font-size="12" fill="#8A8A8A">${ttlLabel(v)}</text>` +
    '</svg>'
  return <Svg source={source} alt={`${big}, ${word}, ${ttlLabel(v)}`} width={340} height={48} />
}

// ---- The pane ----

type Pieces = { header: JSX.Element; chart: JSX.Element }

// The common part of both surfaces' element tables; the sections below use nothing else.
type Common = ElementTable<'terminal'>

function body(el: Common, v: View, a: PaneActions, pieces: Pieces) {
  const { Box, Text, Button, Select } = el
  const row = (key: string, label: string, value: string) => (
    <Box key={key} flexDirection="row">
      <Box width={LABEL_COLUMNS}>
        <Text color={COLORS.muted}>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  )
  const heading = (text: string) => (
    <Box key={`h-${text}`} marginTop={1}>
      <Text bold>{text}</Text>
    </Box>
  )
  const t = v.totals
  const priced = t.isPriced
  const breaks = [...v.breaks].reverse().slice(0, 8)
  const hasCache = v.cache.startedAt > 0
  const pings = v.pings
  return (
    <Box flexDirection="column">
      {pieces.header}
      {heading('This session')}
      {row('requests', 'Requests', String(t.requests))}
      {row('hit', 'Hit rate', t.requests > 0 ? `${sessionHitRate(v)}%` : 'n/a')}
      {row('read', 'Tokens read', fmtTokens(t.read))}
      {row('written', 'Tokens written', fmtTokens(t.written))}
      {row('uncached', 'Tokens uncached', fmtTokens(t.uncached))}
      {row('saved', 'Estimated savings', priced ? `~${fmtUsd(t.savingsUsd)}` : 'n/a (model price unknown)')}
      {row('writecost', 'Cache writes cost', priced ? `~${fmtUsd(t.writeCostUsd)}` : 'n/a (model price unknown)')}
      {v.history.length > 0 ? heading(`Last ${v.history.length} requests`) : null}
      {v.history.length > 0 ? pieces.chart : null}
      {heading('Breaks')}
      {breaks.length === 0 ? (
        <Text color={COLORS.muted}>None this session.</Text>
      ) : (
        breaks.map(b => (
          <Box key={`brk${b.at}`} flexDirection="row" columnGap={2}>
            <Text color={COLORS.muted}>{fmtLocalTime(b.at)}</Text>
            <Text>{`${fmtTokens(b.written)} re-written`}</Text>
            <Text>{b.costUsd === null ? 'cost n/a' : `~${fmtUsd(b.costUsd)}`}</Text>
            <Text color={COLORS.muted}>{b.cause}</Text>
          </Box>
        ))
      )}
      {heading('Keep warm')}
      <Box flexDirection="row" columnGap={1}>
        <Button
          key="keep"
          label={`Keep warm: ${v.settings.keepWarm ? 'on' : 'off'}`}
          onPress={a.toggleKeepWarm}
          {...(v.settings.keepWarm ? { variant: 'primary' as const } : {})}
        />
      </Box>
      <Select key="lead" label="Ping this long before expiry" options={LEAD_OPTIONS} value={v.settings.lead} onSelect={a.setLead} />
      <Select key="cap" label="Stop after idle for" options={CAP_OPTIONS} value={v.settings.idleCap} onSelect={a.setIdleCap} />
      <Text>{pingsLine(pings)}</Text>
      {v.settings.keepWarm && v.paused ? <Text color={COLORS.muted}>{`Paused: you have been idle for ${v.paused}.`}</Text> : null}
      <Text color={COLORS.muted}>{PING_SENTENCE}</Text>
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        {hasCache && !v.isExpired ? <Button key="warm" label="Warm now" onPress={a.warmNow} /> : null}
        <Button key="compact" label="Compact" onPress={a.compact} />
        <Button key="close" label="Close" onPress={a.close} />
      </Box>
    </Box>
  )
}

export function terminalPane(el: ElementTable<'terminal'>, v: View, columns: number, a: PaneActions) {
  return body(el, v, a, { header: terminalHeader(el, v), chart: terminalChart(el, v.history, columns) })
}

export function desktopPane(el: ElementTable<'desktop'>, v: View, a: PaneActions) {
  // Box, Text, Button and Select draw the same on both surfaces.
  return body(el as unknown as Common, v, a, { header: desktopHeader(el, v), chart: desktopChart(el, v.history) })
}
