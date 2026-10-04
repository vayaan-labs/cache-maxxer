import type { ElementTable } from 'claude-code'

import { buildSegments, planLines, runsText, type Run, type Seg } from './layout'
import type { Tone, View } from './view'

// Mid tones, so they read on light and dark alike.
export const COLORS: Record<Tone, string> = {
  // The terminal leaves the default color (see colorProps); the SVG falls back to this grey
  fg: '#8A8A8A',
  muted: '#8A8A8A',
  warm: '#3E9E6E',
  warn: '#D08A1E',
  danger: '#D64545',
  accent: '#D97757',
}

// The terminal's default text color is no color prop at all.
export const colorProps = (tone: Tone) => (tone === 'fg' ? {} : { color: COLORS[tone] })

export type Actions = {
  toggleKeepWarm: () => void
  warmNow: () => void
  compact: () => void
  details: () => void
}

type ButtonSpec = { key: string; label: string; isPrimary: boolean; press: () => void }

function buttonSpecs(v: View, a: Actions): ButtonSpec[] {
  const specs: ButtonSpec[] = [
    { key: 'keep', label: `Keep warm: ${v.settings.keepWarm ? 'on' : 'off'}`, isPrimary: v.settings.keepWarm, press: a.toggleKeepWarm },
  ]
  if (v.cache.startedAt > 0 && !v.isExpired) specs.push({ key: 'warm', label: 'Warm now', isPrimary: false, press: a.warmNow })
  if (v.isExpired) specs.push({ key: 'compact', label: 'Compact', isPrimary: false, press: a.compact })
  specs.push({ key: 'details', label: 'Details', isPrimary: false, press: a.details })
  return specs
}

const TRACK_CELLS = 12
const BLOCKS = '▁▂▃▄▅▆▇█'

// The terminal draws every piece as text, one cell per character.
function terminalRuns(s: Seg): Run[] {
  if (s.id === 'dot') return [{ text: '● ', tone: s.tone ?? 'muted' }]
  if (s.id === 'track') {
    const filled = Math.round((s.frac ?? 0) * TRACK_CELLS)
    return [
      { text: ' ▕', tone: 'muted' },
      { text: '█'.repeat(filled), tone: s.tone ?? 'warm' },
      { text: '░'.repeat(TRACK_CELLS - filled), tone: 'muted' },
      { text: '▏', tone: 'muted' },
    ]
  }
  if (s.id === 'spark') {
    const runs: Run[] = []
    for (const bar of s.bars ?? []) {
      const tone: Tone = bar.isBreak ? 'danger' : 'warm'
      const ch = BLOCKS[Math.min(7, Math.floor(bar.share * 8))]!
      const prev = runs[runs.length - 1]
      if (prev && prev.tone === tone) prev.text += ch
      else runs.push({ text: ch, tone })
    }
    return runs
  }
  return s.runs ?? []
}

const terminalWidth = (s: Seg) => runsText(terminalRuns(s)).length

const SEPARATOR: Run = { text: ' │ ', tone: 'muted' }

export function terminalBand(el: ElementTable<'terminal'>, v: View, columns: number, a: Actions) {
  const { Box, Text, Button } = el
  const [line = []] = planLines(buildSegments(v), terminalWidth, SEPARATOR.text.length, columns, false)
  const runs: Run[] = []
  line.forEach((s, i) => {
    if (i > 0 && line[i - 1]!.group !== s.group) runs.push(SEPARATOR)
    runs.push(...terminalRuns(s))
  })
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {runs.map((r, i) => (
          <Text key={`r${i}`} {...colorProps(r.tone)} {...(r.bold ? { bold: true } : {})}>
            {r.text}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" columnGap={1}>
        {buttonSpecs(v, a).map(b => (
          <Button key={b.key} label={b.label} onPress={b.press} {...(b.isPrimary ? { variant: 'primary' as const } : {})} />
        ))}
      </Box>
    </Box>
  )
}

// ---- Desktop: an SVG row, then real buttons beside it (an SVG is not clickable) ----

const FONT = 12
const ROW = 24
const SEP_PX = 21
const TRACK_PX = 140
const BAR_W = 3
const BAR_GAP = 2
const BAR_MAX = 16
const CELL_PX = 7.5

// Text width in pixels, estimated by character class (measured against the system font): the SVG
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
    else if (c === '×') w += 0.6
    else if (/[MW]/.test(c)) w += 0.85
    else if (/[A-Z]/.test(c)) w += 0.62
    else w += 0.48
  }
  return w * FONT * (bold ? 1.06 : 1) * 1.03
}

const runsPx = (runs: readonly Run[]) => runs.reduce((n, r) => n + textPx(r.text, r.bold), 0)

function segPx(s: Seg): number {
  if (s.id === 'dot') return 14
  if (s.id === 'track') return TRACK_PX + 12
  if (s.id === 'spark') return (s.bars?.length ?? 0) * (BAR_W + BAR_GAP)
  return runsPx(s.runs ?? [])
}

const escapeXml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Numbers take the page's text color: dark on a light theme and light on a dark one. The mid-grey
// attribute is what shows where the stylesheet is not applied.
const STYLE =
  '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:12px;white-space:pre}' +
  '.n{fill:#222}.b{font-weight:600}.t{font-variant-numeric:tabular-nums}' +
  '@media (prefers-color-scheme:dark){.n{fill:#EDEDED}}</style>'

function runSvg(r: Run): string {
  const cls = [r.tone === 'fg' ? 'n' : '', r.bold ? 'b' : ''].filter(Boolean).join(' ')
  const fill = COLORS[r.tone]
  return `<tspan fill="${fill}"${cls ? ` class="${cls}"` : ''}>${escapeXml(r.text)}</tspan>`
}

const segText = (s: Seg): string => (s.bars || s.id === 'dot' || s.id === 'track' ? '' : runsText(s.runs ?? []))

export function svgBand(lines: readonly (readonly Seg[])[]): { source: string; width: number; height: number; alt: string } {
  const parts: string[] = []
  const alt: string[] = []
  let widest = 0
  lines.forEach((line, row) => {
    const cy = 15 + row * ROW
    let x = 2
    const groups: string[] = []
    // Neighbouring text pieces are drawn as one text, so the browser sets the spaces between them
    // rather than this estimate.
    let flow: Run[] = []
    const flush = () => {
      if (flow.length === 0) return
      parts.push(`<text x="${x}" y="${cy + 4}" class="t" xml:space="preserve">${flow.map(runSvg).join('')}</text>`)
      x += runsPx(flow)
      flow = []
    }
    line.forEach((s, i) => {
      groups[s.group] = (groups[s.group] ?? '') + segText(s)
      if (i > 0 && line[i - 1]!.group !== s.group) {
        flush()
        parts.push(`<line x1="${x + 10}" y1="${cy - 7}" x2="${x + 10}" y2="${cy + 7}" stroke="#8A8A8A" stroke-opacity="0.4"/>`)
        x += SEP_PX
      }
      if (s.runs) {
        flow.push(...s.runs)
        return
      }
      flush()
      if (s.id === 'dot') {
        parts.push(`<circle cx="${x + 4}" cy="${cy}" r="4" fill="${COLORS[s.tone ?? 'muted']}"/>`)
      } else if (s.id === 'track') {
        const fill = Math.round((s.frac ?? 0) * TRACK_PX)
        parts.push(
          `<rect x="${x + 4}" y="${cy - 2}" width="${TRACK_PX}" height="4" rx="2" fill="#8A8A8A" fill-opacity="0.25"/>`,
          `<rect x="${x + 4}" y="${cy - 2}" width="${fill}" height="4" rx="2" fill="${COLORS[s.tone ?? 'warm']}"/>`,
        )
      } else if (s.id === 'spark') {
        ;(s.bars ?? []).forEach((b, k) => {
          const h = Math.max(3, Math.round(b.share * BAR_MAX))
          const bx = x + k * (BAR_W + BAR_GAP)
          parts.push(`<rect x="${bx}" y="${cy + 8 - h}" width="${BAR_W}" height="${h}" rx="1.5" fill="${COLORS.warm}" fill-opacity="0.85"/>`)
          if (b.isBreak) parts.push(`<circle cx="${bx + BAR_W / 2}" cy="${cy - 9}" r="2" fill="${COLORS.danger}"/>`)
        })
      }
      x += segPx(s)
    })
    flush()
    widest = Math.max(widest, x)
    alt.push(groups.filter(g => g.trim() !== '').map(g => g.trim()).join(' | '))
  })
  const width = Math.ceil(widest + 4)
  const height = 6 + ROW * lines.length
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    STYLE +
    parts.join('') +
    '</svg>'
  return { source, width, height, alt: alt.join(' / ') }
}

// The SVG for the room it has, in pixels: one line, or two when one cannot hold the band.
const desktopSvg = (v: View, room: number) => svgBand(planLines(buildSegments(v), segPx, SEP_PX, room, true))

export function desktopBand(el: ElementTable<'desktop'>, v: View, columns: number, a: Actions) {
  const { Box, Svg, Button } = el
  const buttons = buttonSpecs(v, a)
  const buttonsPx = buttons.reduce((n, b) => n + b.label.length * 7.2 + 30, 0) + (buttons.length - 1) * 8
  const room = Math.max(160, columns * CELL_PX - buttonsPx - 24)
  const svg = desktopSvg(v, room)
  return (
    <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
      <Svg source={svg.source} alt={svg.alt} width={svg.width} height={svg.height} />
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {buttons.map(b => (
          <Button key={b.key} label={b.label} onPress={b.press} {...(b.isPrimary ? { variant: 'primary' as const } : {})} />
        ))}
      </Box>
    </Box>
  )
}

