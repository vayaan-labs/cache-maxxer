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
  on('session.surfaces', () => ({ value: ['terminal'] }) as never)
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
const keepWarmOff = ($: Engine) => $.command.run({ command: 'cache-maxxer', args: 'keep off' } as never)
const openDetail = ($: Engine) => $.command.run({ command: 'cache-maxxer', args: '' } as never)
const closeDetail = ($: Engine) => $.command.run({ command: 'cache-maxxer', args: 'less' } as never)

const BAND = (columns: number) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} }) as never

const band = ($: Engine, surface: 'terminal' | 'desktop', columns = 200) =>
  $.ui.mount({ plugin: 'cache-maxxer', surface, component: 'AbovePrompt', props: BAND(columns) })

const textsOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')

const labelsOf = async (ui: { findAll: (q: { type: string }) => Promise<{ props: { label?: unknown } }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.props.label)

// How a drawn node reads in a terminal: text as it is, a button as "[ label ]", the pieces of a row
// side by side (a row's column gap between them, a Box of fixed width taking that width) and the rows
// of a column one under another.
type DrawnProps = { flexDirection?: string; columnGap?: number; label?: string; width?: number; color?: string }
type Node = { type?: string; props?: DrawnProps; children?: unknown[] }

const textIn = (node: unknown): string => (typeof node === 'string' ? node : ((node as Node).children ?? []).map(textIn).join(''))

function rowsOf(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  const n = node as Node
  if (n.type === 'Button') return [`[ ${n.props?.label} ]`]
  if (n.type !== 'Box') return [textIn(node)]
  const kids = (n.children ?? []).map(rowsOf)
  if (n.props?.flexDirection === 'column') return kids.flat()
  const row = kids.map(k => k.join(' ')).join(' '.repeat(n.props?.columnGap ?? 0))
  return [typeof n.props?.width === 'number' ? row.padEnd(n.props.width) : row]
}

// The columns a drawn row takes: its texts and buttons side by side with the row's gaps between.
function cellsIn(node: unknown): number {
  const n = node as Node
  if (typeof node === 'string') return node.length
  if (n.type === 'Button') return (n.props?.label?.length ?? 0) + 4
  if (n.type !== 'Box') return textIn(node).length
  const kids = (n.children ?? []).map(cellsIn)
  const own = n.props?.flexDirection === 'column' ? Math.max(0, ...kids) : kids.reduce((a, b) => a + b, 0) + (n.props?.columnGap ?? 0) * Math.max(0, kids.length - 1)
  return typeof n.props?.width === 'number' ? Math.max(own, n.props.width) : own
}

// The drawn rows wider than the room they have: text that would wrap or be cut.
function overflowing(node: unknown, width: number): string[] {
  const n = node as Node
  if (typeof node === 'string' || n.type !== 'Box') return []
  if (n.props?.flexDirection !== 'column') return cellsIn(node) > width ? [rowsOf(node).join(' ')] : []
  return (n.children ?? []).flatMap(k => overflowing(k, width))
}

// The lines the band takes, the line another mod drew under it included.
function linesOf(node: unknown): number {
  const n = node as Node
  if (typeof node === 'string' || n.type !== 'Box') return 1
  const kids = (n.children ?? []).map(linesOf)
  return n.props?.flexDirection === 'column' ? kids.reduce((a, b) => a + b, 0) : Math.max(1, ...kids)
}

// Every color a terminal Text names: the band draws in the person's theme, so each is a theme key.
function colorsIn(node: unknown, out: string[] = []): string[] {
  const n = node as Node
  if (typeof node === 'string' || !n) return out
  if (n.type === 'Text' && n.props?.color) out.push(n.props.color)
  for (const k of n.children ?? []) colorsIn(k, out)
  return out
}

const WIDTHS = [...Array.from({ length: 91 }, (_, i) => 40 + i), 140, 160, 200, 250]

// At every width the terminal band draws no row wider than itself, on both surfaces the buttons are
// whole, and the text holds every part in `parts`.
async function expectBandFits($: Engine, state: string, parts: readonly string[] = []) {
  for (const columns of WIDTHS) {
    const ui = await band($, 'terminal', columns)
    const [root] = await ui.findAll({ type: 'Box' })
    expect(overflowing(root, columns), `${state}, ${columns} wide: a row wider than the band`).toEqual([])
    const text = (await textsOf(ui)) + (await labelsOf(ui)).join(' ')
    for (const part of parts) expect(text, `${state}, ${columns} wide: ${part}`).toContain(part)
    await ui.unmount()
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

  await openDetail($)
  const text = await textsOf(await band($, 'terminal'))
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
  await openDetail($)
  expect(await textsOf(await band($, 'terminal'))).toContain('1 request')
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
  // The keep-warm row shows with keep warm on, the detail closed or not.
  expect(await textsOf(ui)).toContain('1 background ping so far')
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

  // The rebuilt entry is warm from the ping on, and the keep-warm row does not call it a kept-warm ping.
  await clock.advance(30 * 1000)
  expect(fork.calls).toBe(1)
  const text = await textsOf(await band($, 'terminal', 200))
  expect(text).toMatch(/● 4:[0-9]{2}/)
  expect(text).toContain('No ping has kept it warm yet · 1 rebuilt a lapsed cache · ~$0.31')
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
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await textsOf(await band($, surface)), surface).toMatch(/Paused: (you have been )?idle for 1h\./)
  }

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
  // Warm now has a key of its own while the band has the focus.
  expect((await ui.find({ key: 'warm' }))?.props.hotkey).toBe('w')
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
  expect(await textsOf(early)).toContain('1 hour cache, assumed')
  await early.unmount()

  transcript.tail = `{"type":"system"}\n${line}\n`
  await clock.advance(20 * 1000)
  const text = await textsOf(await band($, 'terminal'))
  // Five minutes, known: the countdown is a five-minute one and nothing says assumed.
  expect(text).toMatch(/● 4:[0-9]{2}/)
  expect(text).toContain('5 minute cache')
  expect(text).not.toContain('assumed')
})

slow('closed, the band is one line: the countdown, the cache length, the hit rate and the buttons', async ($, on) => {
  const { clock, request } = await boot($, on)
  // Nothing to show before the first request, until the detail is asked for.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await textsOf(ui)).toBe('drawn by Claude Code')
    await ui.unmount()
  }
  await openDetail($)
  const empty = await band($, 'terminal')
  expect(await textsOf(empty)).toContain('No cache yet')
  expect(await textsOf(empty)).toContain('No requests yet')
  expect(await labelsOf(empty)).toEqual(['Keep warm: off', 'Less ▴'])
  await empty.unmount()
  await closeDetail($)

  for (const use of THREE) await request(use)
  await clock.advance(10 * 1000)

  const terminal = await band($, 'terminal')
  const [root] = await terminal.findAll({ type: 'Box' })
  const text = await textsOf(terminal)
  expect(text).toContain('● 59:50')
  expect(text).toContain('━')
  expect(text).toContain('1 hour cache, assumed')
  expect(text).toContain('97% hit')
  // The session's numbers wait for the detail.
  expect(text).not.toContain('requests')
  expect(await labelsOf(terminal)).toEqual(['Keep warm: off', 'Warm now', 'More ▾'])
  // One line, then the line another mod drew in the same place.
  expect(linesOf(root)).toBe(2)
  expect(text.endsWith('drawn by Claude Code')).toBe(true)
  // Every color is one of the person's theme keys, never a fixed color.
  for (const color of colorsIn(root)) expect(['inactive', 'success', 'warning', 'error', 'claude'], color).toContain(color)
  await terminal.unmount()

  const desktop = await band($, 'desktop')
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg?.props.alt).toContain('59:50')
  expect(svg?.props.alt).toContain('1 hour cache, assumed')
  expect(await textsOf(desktop)).toContain('97% hit')
  expect(await textsOf(desktop)).toContain('drawn by Claude Code')
  expect(await labelsOf(desktop)).toEqual(['Keep warm: off', 'Warm now', 'More ▾'])
  await desktop.unmount()

  // Once the entry lapses the band says what the next message re-writes, and offers to compact.
  await clock.advance(61 * MINUTE)
  const expired = await band($, 'terminal')
  expect(await textsOf(expired)).toContain('expired  next message re-writes 63K tokens (~$0.51)')
  expect(await labelsOf(expired)).toEqual(['Keep warm: off', 'Compact', 'More ▾'])
})

slow('More opens the detail in the band and Less closes it, and the choice is kept', async ($, on) => {
  const { clock, request } = await boot($, on)
  for (const use of THREE) await request(use)
  await clock.advance(5 * MINUTE)
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface, 200)
    expect((await ui.find({ key: 'more' }))?.props.hotkey).toBe('m')
    await ui.press({ key: 'more' })
    const text = await textsOf(ui)
    // The session's numbers, each labelled once, the requests and the latest break, under their labels.
    for (const part of ['This session', '% hit', '4 requests', 'read', 'written', 'uncached', 'context', 'saved ', 'writes ~$', 'Requests', 'Last break', '63K re-written', 'prefix changed (system prompt, tools or MCP servers)']) {
      expect(text, `${surface}: ${part}`).toContain(part)
    }
    if (surface === 'terminal') expect(text).toContain('■ read')
    else expect((await ui.findAll({ type: 'Svg' })).length).toBe(2)
    expect(await labelsOf(ui)).toEqual(['Keep warm: off', 'Warm now', 'Less ▴'])
    // With keep warm off its choices are not drawn.
    expect(await ui.find({ key: 'lead' })).toBeUndefined()
    await ui.press({ key: 'more' })
    expect(await textsOf(ui)).not.toContain('This session')
    await ui.unmount()
  }

  // The detail stays open for the next session, as keep warm does.
  await openDetail($)
  await $.session.end({ reason: 'clear' } as never)
  await $.classic.SessionStart({ source: 'clear' } as never)
  await request({ read: 0, written: 60_000, uncached: 20, output: 300 })
  expect(await textsOf(await band($, 'terminal'))).toContain('This session')
})

fiveMinute('keep warm shows its choices in the band whenever it is on, and they choose by button', async ($, on) => {
  const { request } = await boot($, on)
  for (const use of THREE) await request(use)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface, 160)
    expect(await ui.find({ key: 'lead' })).toBeUndefined()

    // Keep warm on brings its choices and the pings line, the detail closed.
    await ui.press({ key: 'keep' })
    expect((await ui.find({ key: 'keep' }))?.props.label).toBe('Keep warm: on')
    expect((await ui.find({ key: 'keep' }))?.props.variant).toBe('primary')
    expect(await textsOf(ui)).toContain('Keep warm')
    expect(await textsOf(ui)).toContain('No pings yet.')
    // A closed choice is a button that says it opens: its arrow and a hint to click it.
    expect((await ui.find({ key: 'lead' }))?.props.label).toBe('Ping: automatically before expiry ▾')
    expect((await ui.find({ key: 'cap' }))?.props.label).toBe('Stop: after 3 hours idle ▾')
    expect(await textsOf(ui)).toContain('click to change')

    // Opened, it lists its options as buttons and offers Cancel; a pick closes it.
    await ui.press({ key: 'lead' })
    expect(await textsOf(ui)).toContain('Ping before expiry:')
    const open = await labelsOf(ui)
    expect(open.filter(l => !['Keep warm: on', 'Warm now', 'More ▾'].includes(l as string))).toEqual(['automatic', '1 minute', '2 minutes', '4 minutes', '8 minutes', 'Cancel'])
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

    // Toggled any number of times, by button or command, the choices show exactly while it is on.
    let isOn = true
    for (const by of ['button', 'command', 'button', 'button', 'command'] as const) {
      if (by === 'button') await ui.press({ key: 'keep' })
      else await (isOn ? keepWarmOff($) : keepWarmOn($))
      isOn = !isOn
      expect(Boolean(await ui.find({ key: 'lead' })), `${surface}: keep warm ${isOn ? 'on' : 'off'}`).toBe(isOn)
      expect((await ui.find({ key: 'keep' }))?.props.label).toBe(`Keep warm: ${isOn ? 'on' : 'off'}`)
    }
    expect(isOn).toBe(false)
    await ui.unmount()
  }
})

slow('the band never draws a row wider than itself and loses nothing, from 40 to 250 columns, in every state', async ($, on) => {
  const { clock, request } = await boot($, on)
  await openDetail($)
  await expectBandFits($, 'no cache, open', ['No cache yet'])
  await closeDetail($)

  for (const use of THREE) await request(use)
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })
  await clock.advance(10 * 1000)
  // Closed, every piece of the first line is there at every width, whatever row it landed on.
  await expectBandFits($, 'warm, closed', ['● 59:50', '% hit', 'Keep warm: off'])
  await openDetail($)
  await expectBandFits($, 'warm, open, two breaks', ['● 59:50', 'This session', '5 requests', 'Last break', 'and 1 more'])
  await keepWarmOn($)
  await expectBandFits($, 'warm, open, keep warm on', ['Ping:', 'Stop:', 'No pings yet.'])
  const ui = await band($, 'terminal')
  await ui.press({ key: 'cap' })
  await ui.unmount()
  await expectBandFits($, 'warm, open, a choice open', ['Stop when idle for:', 'never stop', 'Cancel'])
  await keepWarmOff($)

  // Expiring soon says so in words as well as color.
  await clock.advance(52 * MINUTE)
  await expectBandFits($, 'expiring soon, open', ['expiring soon'])
  await closeDetail($)
  await expectBandFits($, 'expiring soon, closed', ['expiring soon'])

  await clock.advance(9 * MINUTE)
  await expectBandFits($, 'expired, closed', ['expired', 're-writes'])
  await openDetail($)
  await keepWarmOn($)
  await expectBandFits($, 'expired, open, keep warm on', ['expired', 'Compact', 'Ping:'])

  // Wide enough, the first line holds the status and the buttons together.
  await closeDetail($)
  await keepWarmOff($)
  const wide = await band($, 'terminal', 200)
  const [root] = await wide.findAll({ type: 'Box' })
  expect(linesOf(root)).toBe(2)
})

idleCap('the band fits its width with pings counted and keep warm paused for idleness', async ($, on) => {
  const { clock, fork, request } = await boot($, on)
  await keepWarmOn($)
  for (const use of THREE) await request(use)
  await request({ read: 0, written: 63_000, uncached: 20, output: 100 })
  await clock.advance(66 * MINUTE)
  expect(fork.calls).toBeGreaterThan(5)
  await openDetail($)
  await expectBandFits($, 'pings counted and paused', ['Paused: ', 'pings so far'])
})
