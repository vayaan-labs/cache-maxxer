import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import { inferCause, isBreak } from '../hooks/model'
import { parseTtl } from '../hooks/ttl'

const T0 = Date.parse('2026-10-04T10:00:00Z')
const MINUTE = 60_000
const OPUS = 'claude-opus-5-5'

// A 5 minute entry keeps the tests that move the clock short: its ticks are few.
type Body = Parameters<typeof test>[1]
const withOptions = (options: Record<string, unknown>) => (name: string, body: Body) => test(name, options as never, body as never)
const fiveMinute = withOptions({ options: { ttl: '5m' }, timeoutMs: 30_000 })
const slow = withOptions({ timeoutMs: 30_000 })
const idleCap = withOptions({ options: { ttl: '5m', idle_cap: '1h' }, timeoutMs: 60_000 })

type Use = { read: number; written: number; uncached: number; output: number; model?: string }

// The engine beneath the mod: a clock the test moves, a store in memory, toasts collected, a model
// request that answers with whatever the test set, and a fork that counts its calls.
async function boot($: Engine, on: On, transcript: { path: string; tail: string } = { path: '', tail: '' }) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {})
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }) as never)

  let current: Use = { read: 0, written: 0, uncached: 0, output: 0 }
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'ok' } as never
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: current.uncached,
        output_tokens: current.output,
        cache_read_input_tokens: current.read,
        cache_creation_input_tokens: current.written,
        model: current.model ?? OPUS,
      },
    } as never
  })

  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  const fork = {
    calls: 0,
    // What a ping reads back; the test replaces it to slow a ping down or fail it.
    answer: async (): Promise<unknown> => ({
      isAnswered: true,
      text: 'ok',
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 61_000, cache_creation_input_tokens: 0 },
    }),
  }
  on('model.fork', async () => {
    fork.calls += 1
    return { value: await fork.answer() } as never
  })

  // Where the session's transcript is, as the mod finds it: one find, then the tail of the file.
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === '/usr/bin/find' ? transcript.path : transcript.tail, stderr: '' },
  }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('session.end', () => ({ sessionId: 'session-1' }) as never)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const request = async (use: Use, extra: Record<string, unknown> = {}) => {
    current = use
    const step = $.turn.step({ turnId: 't1', index: 0, model: use.model ?? OPUS, messageCount: 1, ...extra } as never)
    for await (const chunk of step) void chunk
    await step.result
  }
  return { clock, toasts, fork, request }
}

// The command, as the person types it.
const keepWarmOn = ($: Engine) => $.command.run({ command: 'cache-maxxer', args: 'keep on' } as never)

const BAND = (columns: number) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: columns, scroll: { offset: 0, bodyRows: 6 }, view: {} }) as never
const PANE = (columns: number) =>
  ({ title: 'Cache Maxxer', isFocused: true, bodyColumns: columns, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as never

const band = ($: Engine, surface: 'terminal' | 'desktop', columns = 200) =>
  $.ui.mount({ plugin: 'cache-maxxer', surface, component: 'AbovePrompt', props: BAND(columns) })
const pane = ($: Engine, surface: 'terminal' | 'desktop', columns = 80) =>
  $.ui.mount({ plugin: 'cache-maxxer', surface, component: 'Pane', requestId: 'cache-maxxer', props: PANE(columns) })

const textsOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')

type Drawn = { type?: string; props?: { flexDirection?: string }; children?: unknown[] }

// The lines a drawn pane takes: a row is one line, a column is its children stacked.
function linesOf(node: unknown): number {
  const drawn = node as Drawn
  if (typeof node === 'string' || drawn.type !== 'Box') return 1
  const kids = (drawn.children ?? []).map(linesOf)
  return drawn.props?.flexDirection === 'column' ? kids.reduce((a, b) => a + b, 0) : Math.max(1, ...kids)
}

// How a drawn node reads in a terminal: text as it is, a button as "[ label ]", the pieces of a row
// side by side (a row's column gap between them) and the rows of a column one under another.
type DrawnProps = { flexDirection?: string; columnGap?: number; label?: string }
type Node = { type?: string; props?: DrawnProps; children?: unknown[] }
function rowsOf(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  const n = node as Node
  if (n.type === 'Button') return [`[ ${n.props?.label} ]`]
  if (n.type !== 'Box') return [textIn(node)]
  const kids = (n.children ?? []).map(rowsOf)
  if (n.props?.flexDirection === 'column') return kids.flat()
  return [kids.map(k => k.join(' ')).join(' '.repeat(n.props?.columnGap ?? 0))]
}

// The drawn rows wider than the room they have: text that would wrap or be cut.
const textIn = (node: unknown): string => (typeof node === 'string' ? node : ((node as Drawn).children ?? []).map(textIn).join(''))
function overflowing(node: unknown, width: number): string[] {
  const drawn = node as Drawn
  if (typeof node === 'string' || drawn.type !== 'Box') return []
  if (drawn.props?.flexDirection !== 'column') return cellsIn(node) > width ? [rowsOf(node).join(' ')] : []
  return (drawn.children ?? []).flatMap(k => overflowing(k, width))
}

// The columns a drawn row takes: its texts and buttons side by side with the row's gaps between.
function cellsIn(node: unknown): number {
  const n = node as Node
  if (typeof node === 'string') return node.length
  if (n.type === 'Button') return (n.props?.label?.length ?? 0) + 4
  if (n.type !== 'Box') return textIn(node).length
  const kids = (n.children ?? []).map(cellsIn)
  return n.props?.flexDirection === 'column' ? Math.max(0, ...kids) : kids.reduce((a, b) => a + b, 0) + (n.props?.columnGap ?? 0) * Math.max(0, kids.length - 1)
}

// The pane's own width in a real terminal is not the terminal's: inline at 76 columns in one 80 wide,
// docked at the side at 49 in one 120 wide and 71 in one 160 wide, and as narrow as 38 just past the
// width where it docks. From 120 columns the pane holds to five lines; narrower, its rows wrap onto
// more lines rather than cut anything. At every width no row of the terminal pane is wider than the pane.
const PANE_WIDTHS = [38, 40, 49, 60, 71, 76, 90, 104, 120, 200, 250]

async function expectPaneFits($: Engine, state: string, fiveLinesFrom = 120) {
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of PANE_WIDTHS) {
      const ui = await $.ui.mount({ plugin: 'cache-maxxer', surface, component: 'Pane', requestId: 'cache-maxxer', props: PANE(columns) })
      const [root] = await ui.findAll({ type: 'Box' })
      if (columns >= fiveLinesFrom) expect(linesOf(root), `${state}, ${surface}, ${columns} wide`).toBeLessThanOrEqual(5)
      if (surface === 'terminal') expect(overflowing(root, columns), `${state}, ${columns} wide: a row wider than the pane`).toEqual([])
      await ui.unmount()
    }
  }
}

// Three requests of a long conversation: 97% of the last one read from the cache.
const THREE: Use[] = [
  { read: 0, written: 60_400, uncached: 30, output: 300 },
  { read: 60_000, written: 1_500, uncached: 40, output: 250 },
  { read: 61_000, written: 2_000, uncached: 60, output: 350 },
]

test('every cache break names its cause', () => {
  const base = { gapMs: 5 * MINUTE, ttlMs: 60 * MINUTE, prevModel: OPUS, model: OPUS, pending: null }
  const rows: [string, Parameters<typeof inferCause>[0], string][] = [
    ['idle past the entry life', { ...base, gapMs: 63 * MINUTE }, 'expired after 63m idle'],
    ['expiry beats a model switch', { ...base, gapMs: 90 * MINUTE, model: 'claude-sonnet-5-5' }, 'expired after 90m idle'],
    ['a resumed session that lapsed', { ...base, gapMs: null, pending: { kind: 'idle', idleMs: 150 * MINUTE } }, 'expired after 2h 30m idle'],
    ['the model changed', { ...base, model: 'claude-sonnet-5-5' }, 'model switched'],
    ['a compaction ran', { ...base, pending: { kind: 'compacted' } }, 'compacted'],
    ['/clear ran', { ...base, gapMs: null, prevModel: '', pending: { kind: 'cleared' } }, 'cleared'],
    ['nothing else explains it', base, 'prefix changed (system prompt, tools or MCP servers)'],
  ]
  for (const [name, input, cause] of rows) expect(inferCause(input), name).toBe(cause)

  // A break writes more than 20K tokens and reads less than half of what the last request cached.
  expect(isBreak(20_000, 0, 60_000), 'a small write').toBe(false)
  expect(isBreak(60_000, 0, 0), 'no earlier request to lose a prefix from').toBe(false)
  expect(isBreak(30_000, 25_000, 25_000), 'a big new message on a prefix that was read').toBe(false)
  expect(isBreak(30_000, 30_000, 60_000), 'half of the prefix still read').toBe(false)
  expect(isBreak(30_000, 29_999, 60_000), 'less than half read').toBe(true)
  expect(isBreak(60_000, 0, 60_000), 'the prefix was lost').toBe(true)
})

test('the entry life is read from the newest cache write in the transcript', () => {
  const line = (h: number, m: number) =>
    JSON.stringify({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_1h_input_tokens: h, ephemeral_5m_input_tokens: m } } } })
  expect(parseTtl(`cut off mid-line {"x":\n${line(0, 9000)}\n${line(4000, 0)}\n`)).toBe(60 * MINUTE)
  expect(parseTtl(`${line(4000, 0)}\n${line(0, 9000)}\n{"type":"user"}\n`)).toBe(5 * MINUTE)
  expect(parseTtl(`${line(0, 0)}\n{"type":"user"}\n`)).toBeNull()
})

fiveMinute('a rebuilt cache is explained once, and subagent requests do not count', async ($, on) => {
  const { clock, toasts, request } = await boot($, on)
  // The first request of a session writes the whole context and is no break.
  await request({ read: 0, written: 182_000, uncached: 20, output: 300 })
  expect(toasts).toEqual([])

  // A subagent's request reads and writes entries of its own.
  await request({ read: 0, written: 90_000, uncached: 0, output: 10 }, { agentId: 'agent-1' })
  expect(toasts).toEqual([])

  await clock.advance(63 * MINUTE)
  await request({ read: 0, written: 182_000, uncached: 20, output: 300 })
  // The warning that the entry was about to lapse came first, while keep warm was off.
  expect(toasts).toEqual(['Cache expires in 40s · Warm now to keep it', 'Cache rebuilt · 182K tokens re-written · expired after 63m idle'])

  const ui = await pane($, 'terminal')
  const text = await textsOf(ui)
  // Two main requests: the subagent's one is not among them.
  expect(text).toContain('2 requests')
  expect(text).toContain('182K re-written')
  expect(text).toContain('expired after 63m idle')
})

fiveMinute('a big new message on a cached prefix is no break, and a lost prefix is', async ($, on) => {
  const { toasts, request } = await boot($, on)
  await request({ read: 0, written: 25_000, uncached: 20, output: 300 })
  // A large file read early on: 30K tokens written, the 25K prefix still read.
  await request({ read: 25_000, written: 30_000, uncached: 20, output: 300 })
  expect(toasts).toEqual([])

  await request({ read: 0, written: 55_000, uncached: 20, output: 300 })
  expect(toasts).toEqual(['Cache rebuilt · 55K tokens re-written · prefix changed (system prompt, tools or MCP servers)'])
})

fiveMinute('a resumed session starts from the context it had, so a lapsed one is a break and a warm one is not', async ($, on) => {
  const { toasts, request } = await boot($, on)
  const resume = (idleSeconds: number, isExpired: boolean) =>
    $.classic.SessionStart({ source: 'resume', seconds_since_last_response: idleSeconds, context_tokens: 150_000, prompt_cache_likely_expired: isExpired, model: OPUS } as never)

  await resume(100, false)
  await request({ read: 150_000, written: 30_000, uncached: 20, output: 300 })
  expect(toasts).toEqual([])

  await resume(7200, true)
  await request({ read: 0, written: 180_000, uncached: 20, output: 300 })
  expect(toasts).toEqual(['Cache rebuilt · 180K tokens re-written · expired after 2h idle'])
})

fiveMinute('the first request after /clear is told apart from a fresh session, and the totals start over', async ($, on) => {
  const { toasts, request } = await boot($, on)
  await request({ read: 0, written: 60_000, uncached: 20, output: 300 })
  await $.session.end({ reason: 'clear' } as never)
  await request({ read: 0, written: 60_000, uncached: 20, output: 300 })
  expect(toasts).toEqual(['Cache rebuilt · 60K tokens re-written · cleared'])
  expect(await textsOf(await pane($, 'terminal'))).toContain('1 request')
})

fiveMinute('keep warm pings once at the lead time and restarts the entry', async ($, on) => {
  const { clock, toasts, fork, request } = await boot($, on)
  await keepWarmOn($)
  await request({ read: 0, written: 60_000, uncached: 30, output: 100 })

  // A 5 minute entry has 40 seconds of lead: nothing before it, one ping at it.
  await clock.advance(250 * 1000)
  expect(fork.calls).toBe(0)
  await clock.advance(15 * 1000)
  expect(fork.calls).toBe(1)

  // The ping started at 4:20 and restarted the entry then, so it is warm well past the first expiry.
  await clock.advance(30 * 1000)
  const ui = await band($, 'terminal')
  expect(await textsOf(ui)).toMatch(/4:[0-9]{2}/)
  expect(await textsOf(ui)).toContain('kept warm ×1')
  expect(toasts).toEqual([])
})

fiveMinute('a ping that finds the cache already gone says it rebuilt it and does not count as keeping it warm', async ($, on) => {
  const { clock, toasts, fork, request } = await boot($, on)
  await keepWarmOn($)
  await request({ read: 0, written: 60_000, uncached: 30, output: 100 })
  fork.answer = async () => ({
    isAnswered: true,
    text: 'ok',
    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 61_000 },
  })

  await clock.advance(265 * 1000)
  expect(fork.calls).toBe(1)
  expect(toasts).toEqual(['The cache had already expired, so the background request rebuilt it · 61K tokens written, timer restarted · ~$0.31'])

  // The rebuilt entry is warm from the ping on, and the count line does not call it a kept-warm ping.
  await clock.advance(30 * 1000)
  expect(fork.calls).toBe(1)
  const ui = await band($, 'terminal')
  const line = await textsOf(ui)
  expect(line).toMatch(/Cache 4:[0-9]{2}/)
  expect(line).toContain('rebuilt ×1')
  expect(line).not.toContain('kept warm')
  // The whole line is there where the room allows it.
  const details = await pane($, 'terminal', 160)
  expect(await textsOf(details)).toContain('No ping has kept it warm yet · 1 rebuilt a lapsed cache · ~$0.31')
})

fiveMinute('keep warm waits for a running turn, and pings once it ends', async ($, on) => {
  const { clock, fork, request } = await boot($, on)
  await keepWarmOn($)
  await request({ read: 0, written: 60_000, uncached: 30, output: 100 })
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await clock.advance(280 * 1000)
  expect(fork.calls).toBe(0)

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer', usage: null } as never)
  await clock.advance(2 * 1000)
  expect(fork.calls).toBe(1)
})

fiveMinute('keep warm never runs two pings at once and does not retry a failed one', async ($, on) => {
  const { clock, toasts, fork, request } = await boot($, on)
  await keepWarmOn($)
  await request({ read: 0, written: 60_000, uncached: 30, output: 100 })

  // A slow ping: the ticks that land while it is in flight start no second one.
  fork.answer = async () => {
    await clock.sleep(20_000)
    return { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  }
  await clock.advance(262 * 1000)
  expect(fork.calls).toBe(1)
  await clock.advance(30 * 1000)
  expect(toasts).toEqual(['Keep warm skipped: the API answered 529 (overloaded)'])
  // The failure skips this expiry instead of retrying every second.
  await clock.advance(10 * 1000)
  expect(fork.calls).toBe(1)
})

idleCap('keep warm stops once the person has been idle past the cap', async ($, on) => {
  const { clock, fork, request } = await boot($, on)
  await keepWarmOn($)
  await request({ read: 0, written: 60_000, uncached: 30, output: 100 })

  // The first lead time after the hour finds the person idle past the cap.
  await clock.advance(66 * MINUTE)
  const pinged = fork.calls
  expect(pinged).toBeGreaterThan(5)
  const ui = await band($, 'desktop')
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('keep warm paused (idle 1h)')

  await clock.advance(10 * MINUTE)
  expect(fork.calls).toBe(pinged)
})

fiveMinute('warn once with keep warm off, and Warm now pings once on demand', async ($, on) => {
  const { clock, toasts, fork, request } = await boot($, on)
  await request({ read: 0, written: 60_000, uncached: 30, output: 100 })
  await clock.advance(270 * 1000)
  expect(toasts).toEqual(['Cache expires in 40s · Warm now to keep it'])
  expect(fork.calls).toBe(0)

  const ui = await band($, 'terminal')
  await ui.press({ key: 'warm' })
  expect(fork.calls).toBe(1)
  expect(toasts[1]).toBe('Cache kept warm · a background request read 61K tokens from it, so the timer restarted · ~$0.01')
})

fiveMinute('Warm now does nothing while a turn runs, and never pings twice at once', async ($, on) => {
  const { clock, toasts, fork, request } = await boot($, on)
  await request({ read: 0, written: 60_000, uncached: 30, output: 100 })
  const ui = await band($, 'terminal')

  await $.turn.start({ text: 'go on', turnId: 't2' })
  await ui.press({ key: 'warm' })
  expect(fork.calls).toBe(0)
  expect(toasts).toEqual(['Could not warm the cache: Claude is working'])
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer', usage: null } as never)

  // Two presses while the first ping is still in flight make one request.
  fork.answer = async () => {
    await clock.sleep(5000)
    return { isAnswered: true, text: 'ok', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 61_000, cache_creation_input_tokens: 0 } }
  }
  const first = ui.press({ key: 'warm' })
  await clock.advance(1000)
  const second = ui.press({ key: 'warm' })
  await clock.advance(10_000)
  await Promise.all([first, second])
  expect(fork.calls).toBe(1)
  expect(toasts.slice(1)).toEqual(['Could not warm the cache: a ping is already running', expect.stringMatching(/^Cache kept warm · a background request read 61K tokens from it, so the timer restarted/)])
})

slow('auto learns the entry life once the transcript holds the write, though it did not when the turn ended', async ($, on) => {
  const line = JSON.stringify({ message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 61_000 } } } })
  // The turn ends before the write reaches the transcript file.
  const transcript = { path: '/home/u/.claude/projects/p/session-1.jsonl', tail: '{"type":"system"}\n' }
  const { clock, request } = await boot($, on, transcript)
  await request(THREE[0]!)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage: null } as never)
  await clock.advance(5 * 1000)
  const early = await band($, 'terminal')
  expect(await textsOf(early)).toContain('1h?')
  await early.unmount()

  transcript.tail = `{"type":"system"}\n${line}\n`
  await clock.advance(20 * 1000)
  const ui = await band($, 'terminal')
  // Five minutes, known: no "1h?" guess, and the pane stops saying assumed.
  expect(await textsOf(ui)).toMatch(/Cache 4:[0-9]{2}/)
  expect(await textsOf(ui)).not.toContain('1h?')
  const details = await pane($, 'terminal')
  expect(await textsOf(details)).toContain('5 minute cache')
  expect(await textsOf(details)).not.toContain('assumed')
})

slow('the band shows the countdown, hit rates, context, totals and savings on both surfaces', async ($, on) => {
  const { clock, request } = await boot($, on)
  // Nothing to show before the first request.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await textsOf(ui)).toBe('drawn by Claude Code')
    await ui.unmount()
  }

  for (const use of THREE) await request(use)
  await clock.advance(10 * 1000)

  const terminal = await band($, 'terminal')
  const line = await textsOf(terminal)
  expect(line).toContain('Cache 59:50 1h?')
  expect(line).toContain('97% now · 65% session')
  expect(line).toContain('63K ctx')
  expect(line).toContain('121K read · 64K written')
  expect(line).toContain('saved ~$0.20')
  expect((await terminal.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Keep warm: off', 'Warm now', 'Details'])
  // What the mods after this one draw in the same place stays, drawn after the band.
  expect(line.endsWith('drawn by Claude Code')).toBe(true)

  const desktop = await band($, 'desktop')
  const svg = await desktop.find({ type: 'Svg' })
  for (const part of ['59:50', '97% now · 65% session', '63K ctx', '121K read · 64K written', 'saved ~$0.20']) {
    expect(svg?.props.alt).toContain(part)
  }
  expect(String(svg?.props.source)).toContain('>97%<')
  expect(await textsOf(desktop)).toContain('drawn by Claude Code')
  expect((await desktop.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Keep warm: off', 'Warm now', 'Details'])
  await terminal.unmount()
  await desktop.unmount()

  // Once the entry lapses the band says what the next message re-writes, and offers to compact.
  await clock.advance(61 * MINUTE)
  const expired = await band($, 'terminal')
  expect(await textsOf(expired)).toContain('expired · next message re-writes 63K tokens (~$0.51)')
  expect((await expired.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Keep warm: off', 'Compact', 'Details'])
})

slow('as the room narrows the band flows onto more lines and loses nothing from 40 to 250 columns', async ($, on) => {
  const { clock, request } = await boot($, on)
  for (const use of THREE) await request(use)
  await clock.advance(10 * 1000)

  const widths = [...Array.from({ length: 91 }, (_, i) => 40 + i), 140, 160, 200, 250]
  for (const columns of widths) {
    const ui = await band($, 'terminal', columns)
    const [root] = await ui.findAll({ type: 'Box' })
    const text = await textsOf(ui)
    // Every piece of the wide band is on screen, whatever line it landed on.
    for (const part of ['59:50 1h?', '▕', '97% now · 65% session', '63K ctx', '121K read · 64K written', 'saved ~$0.20', '▁██']) {
      expect(text, `${columns} columns: ${part}`).toContain(part)
    }
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label), `${columns} columns`).toEqual(['Keep warm: off', 'Warm now', 'Details'])
    expect(overflowing(root, columns), `${columns} columns: a row wider than the band`).toEqual([])
    await ui.unmount()
  }

  // Wide enough, the band is one line of numbers above one of buttons (and the line another mod drew).
  const wide = await band($, 'terminal', 200)
  expect(rowsOf((await wide.findAll({ type: 'Box' }))[0]).length).toBe(3)
  await wide.unmount()

  // Once expired, what the next message re-writes shortens before it overflows.
  await clock.advance(61 * MINUTE)
  for (const columns of [40, 55, 70, 100, 200]) {
    const ui = await band($, 'terminal', columns)
    const [root] = await ui.findAll({ type: 'Box' })
    expect(await textsOf(ui), `${columns} columns, expired`).toMatch(/expired.*re-writes (63K tokens|63K) \(~\$0\.51\)/)
    expect(overflowing(root, columns), `${columns} columns, expired`).toEqual([])
    await ui.unmount()
  }
})

fiveMinute('the pane shows the latest break and the keep-warm pickers only when there is something to show, and its pickers choose by button', async ($, on) => {
  const { clock, request } = await boot($, on)
  for (const use of THREE) await request(use)
  await clock.advance(5 * MINUTE)
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface, 160)
    const text = await textsOf(ui)
    // The numbers line: hit rate, requests, tokens and the money items, each labelled once.
    for (const part of ['hit', '4 requests', 'read', 'written', 'uncached', 'saved ~$', 'writes ~$']) {
      expect(text, `${surface}: ${part}`).toContain(part)
    }
    // The latest break, with its heading and no explanation sentence.
    expect(text).toContain('Last break')
    expect(text).toContain('63K re-written')
    expect(text).toContain('prefix changed (system prompt, tools or MCP servers)')
    for (const gone of ['This session', 'Breaks', 'A ping is one short request']) expect(text, `${surface}: ${gone}`).not.toContain(gone)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([
      'Warm now',
      'Keep warm: off',
      'Compact',
      ...(surface === 'terminal' ? [] : ['Close']),
    ])
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).length).toBe(2)
    // With keep warm off the pickers are not drawn.
    expect(await ui.find({ key: 'lead' })).toBeUndefined()

    // Keep warm on brings its pickers and the pings line.
    await ui.press({ key: 'keep' })
    expect((await ui.find({ key: 'keep' }))?.props.label).toBe('Keep warm: on')
    expect((await ui.find({ key: 'keep' }))?.props.variant).toBe('primary')
    expect(await textsOf(ui)).toContain('No pings yet.')
    // A closed picker is a button that says it opens: its arrow and a hint to click or press Enter.
    expect((await ui.find({ key: 'lead' }))?.props.label).toBe('Ping: automatically before expiry ▾')
    expect((await ui.find({ key: 'cap' }))?.props.label).toBe('Stop: after 3 hours idle ▾')
    expect(await textsOf(ui)).toContain('click or Enter to change')

    // Opened, it lists its options as buttons, says how to pick and offers Cancel; a pick closes it.
    await ui.press({ key: 'lead' })
    expect(await textsOf(ui)).toContain('click one, or Tab to it and press Enter')
    const open = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
    expect(open.filter(l => !['Warm now', 'Keep warm: on', 'Compact', 'Close'].includes(l as string))).toEqual(['automatic', '1 minute', '2 minutes', '4 minutes', '8 minutes', 'Cancel'])
    expect((await ui.find({ key: 'lead:auto' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'picker-cancel' })
    expect(await ui.find({ key: 'lead:2m' })).toBeUndefined()
    await ui.press({ key: 'lead' })
    await ui.press({ key: 'lead:2m' })
    expect(await ui.find({ key: 'lead:2m' })).toBeUndefined()
    expect((await ui.find({ key: 'lead' }))?.props.label).toBe('Ping: 2 minutes before expiry ▾')
    await ui.press({ key: 'cap' })
    await ui.press({ key: 'cap:none' })
    expect((await ui.find({ key: 'cap' }))?.props.label).toBe('Stop: never ▾')
    for (const [picker, value] of [['lead', 'auto'], ['cap', '3h']] as const) {
      await ui.press({ key: picker })
      await ui.press({ key: `${picker}:${value}` })
    }

    // Keep warm toggled from the pane and from the band, any number of times: the pickers show exactly while it is on.
    const bandUi = await band($, surface)
    let isOn = true
    for (const from of [ui, bandUi, bandUi, ui, ui, bandUi, ui]) {
      await from.press({ key: 'keep' })
      isOn = !isOn
      expect(Boolean(await ui.find({ key: 'lead' })), `${surface}: keep warm ${isOn ? 'on' : 'off'}`).toBe(isOn)
      expect(Boolean(await ui.find({ key: 'cap' })), `${surface}: keep warm ${isOn ? 'on' : 'off'}`).toBe(isOn)
      expect((await bandUi.find({ key: 'keep' }))?.props.label).toBe(`Keep warm: ${isOn ? 'on' : 'off'}`)
    }
    expect(isOn).toBe(false)
    await bandUi.unmount()
    await ui.unmount()
  }

  // Compact stays reachable once the cache has expired, where Warm now is no longer offered.
  await clock.advance(10 * MINUTE)
  const expired = await pane($, 'terminal')
  expect((await expired.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Keep warm: off', 'Compact'])
  expect(await textsOf(expired)).toContain('expired')
})

slow('the pane never draws a row wider than itself, and holds five lines where it is wide, in every state', async ($, on) => {
  const { clock, request } = await boot($, on)
  const keepWarmOff = () => $.command.run({ command: 'cache-maxxer', args: 'keep off' } as never)
  await expectPaneFits($, 'no cache')
  await keepWarmOn($)
  await expectPaneFits($, 'no cache, keep warm on')

  // Two breaks in a row: the latest on its own line with the count of the earlier one.
  for (const use of THREE) await request(use)
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })
  await expectPaneFits($, 'warm, keep warm on, two breaks')
  await keepWarmOff()
  await expectPaneFits($, 'warm, keep warm off, two breaks')

  // The entry's length is still assumed here, and "Expiring soon" is the longest state word.
  await clock.advance(53 * MINUTE)
  await expectPaneFits($, 'expiring soon, keep warm off')
  await keepWarmOn($)
  await expectPaneFits($, 'expiring soon, keep warm on')

  await keepWarmOff()
  await clock.advance(8 * MINUTE)
  await expectPaneFits($, 'expired, keep warm off')
  await keepWarmOn($)
  await expectPaneFits($, 'expired, keep warm on')
})

idleCap('the pane fits its width with pings counted and keep warm paused for idleness', async ($, on) => {
  const { clock, fork, request } = await boot($, on)
  await keepWarmOn($)
  for (const use of THREE) await request(use)
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })
  await clock.advance(66 * MINUTE)
  expect(fork.calls).toBeGreaterThan(5)
  const ui = await pane($, 'terminal', 80)
  const text = await textsOf(ui)
  expect(text).toContain('Paused: ')
  expect(text).toContain('pings so far')
  await ui.unmount()
  // Every item is showing here, so only the widest panes keep it to five lines.
  await expectPaneFits($, 'pings counted and paused', 250)
})
