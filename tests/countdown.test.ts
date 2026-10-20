import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

// The band's props as the terminal hands them; `view` is set per mount.
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 } }

// Each mocked clock step costs the kit about half a second of real time.
const SLOW = { timeoutMs: 15_000 }
const SLOWER = { timeoutMs: 30_000 }

type Agent = { id: string; name?: string; description?: string; status?: string }

type Rig = {
  clock: MockClock
  logs: string[]
  // Calls made to the stubs beneath the plugin.
  calls: { list: number; settings: number; steps: number }
  // The setting's value; a test may change it while the session runs.
  setting: { ttl?: string }
}

// Stubs everything beneath the plugin: clock, settings, roster, the engine's
// own band drawing (a Text reading BELOW), debug log lines, model requests
// that take `responseMs` on the clock, and tool calls that take `toolMs`.
// `agents` is read at each `agent.list`, so a test may edit it. The first
// `settingsFailures` settings reads throw, and so does every one from the
// `settingsFailFrom`th on; a `list` call takes `listMs` on the clock.
function rig(
  on: any,
  opts: { agents?: Agent[]; ttl?: string; responseMs?: number; toolMs?: number; settingsFailures?: number; settingsFailFrom?: number; listMs?: number; listThrows?: boolean } = {},
): Rig {
  const clock = mock.clock(on, { now: 0 })
  const logs: string[] = []
  const agents = opts.agents ?? []
  const calls = { list: 0, settings: 0, steps: 0 }
  const setting = { ttl: opts.ttl }
  on('settings.read', () => {
    calls.settings += 1
    if (calls.settings <= (opts.settingsFailures ?? 0) || calls.settings >= (opts.settingsFailFrom ?? Infinity)) throw new Error('settings unavailable')
    return { value: setting.ttl ? { subagentPromptCacheTtl: setting.ttl } : {} }
  })
  on('agent.list', async () => {
    calls.list += 1
    if (opts.listMs) await clock.sleep(opts.listMs)
    if (opts.listThrows) throw new Error('list unavailable')
    return {
      value: agents.map(a => ({ id: a.id, name: a.name, description: a.description ?? '', type: 'general-purpose', status: a.status ?? 'idle' })),
    }
  })
  on('ui.log', (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'BELOW' })
  })
  on('turn.step', async function* (_$: any, e: any) {
    await clock.sleep(opts.responseMs ?? 0)
    calls.steps += 1
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4_000, model: 'm' },
    }
  })
  on('tool.call', async () => {
    await clock.sleep(opts.toolMs ?? 0)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  return { clock, logs, calls, setting }
}

// Starts one model request for `agentId` and reads its stream to the end.
function step($: any, agentId: string): Promise<unknown> {
  const stream = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'm', messageCount: 1, agentId })
  return (async () => {
    for await (const _ of stream) {
      // forwarded chunks are not under test
    }
    return stream.result
  })()
}

// A request at the clock's current time that answers at once.
async function request($: any, clock: MockClock, agentId: string) {
  const done = step($, agentId)
  await clock.settle()
  await done
}

function mount($: any, view: { agentId?: string } = {}, props: Record<string, unknown> = {}) {
  return $.ui.mount({ plugin: 'cache', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, ...props, view } })
}

// Plugins that log each write of one of the plugin's state values (`write <key>`), and
// may throw on one. The module is loaded on its own: no closure over this file, and the
// keys are literals.
const rosterWrites = {
  name: 'roster-writes',
  register(on: any) {
    on('state.set', { plugin: 'cache', key: 'roster' }, ($: any, e: any, next: any) => {
      $.ui.log('write roster', { to: 'debug' })
      return next(e)
    })
  },
}
const agentWrites = {
  name: 'agent-writes',
  register(on: any) {
    on('state.set', { plugin: 'cache', key: 'agents' }, ($: any, e: any, next: any) => {
      $.ui.log('write agents', { to: 'debug' })
      return next(e)
    })
  },
}
// Refuse the first / the second write of the tracks, which makes the plugin's `$.state.set` throw.
const firstAgentWriteFails = {
  name: 'first-agent-write-fails',
  register(on: any) {
    let n = 0
    on('state.set', { plugin: 'cache', key: 'agents' }, ($: any, e: any, next: any) => {
      n += 1
      if (n === 1) return { deny: 'write refused' }
      return next(e)
    })
  },
}
const secondAgentWriteFails = {
  name: 'second-agent-write-fails',
  register(on: any) {
    let n = 0
    on('state.set', { plugin: 'cache', key: 'agents' }, ($: any, e: any, next: any) => {
      n += 1
      if (n === 2) return { deny: 'write refused' }
      return next(e)
    })
  },
}
const invalidations = {
  name: 'invalidations',
  register(on: any) {
    on('ui.invalidate', ($: any, e: any, next: any) => {
      $.ui.log('invalidate', { to: 'debug' })
      return next(e)
    })
  },
}
const logged = (logs: string[], text: string) => logs.filter(l => l === text).length

// Every string in the drawn tree, in order.
function textOf(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  return (node.children ?? []).map(textOf).join('')
}

// The countdown's own row (the Box keyed `cache`), or undefined.
function cacheRow(tree: any): any {
  const rows: any[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (n.props?.key === 'cache') rows.push(n)
    ;(n.children ?? []).forEach(walk)
  }
  walk(tree)
  return rows[0]
}

test('a request at 0 with a 120 s response is alive at 299 s and gone at 301 s', async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'reviewer-auth' }], responseMs: 120_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const done = step($, 'arev-1')
  await clock.advance(120_000)
  await done
  const ui = await mount($)
  await clock.set(299_000)
  // No redraw call: the session.start ticker invalidates every second.
  await clock.settle()
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  reviewer-auth 0:01')
  await clock.set(301_000)
  await clock.settle()
  const tree = await ui.drawn()
  expect(cacheRow(tree)).toBeUndefined()
  expect(textOf(tree)).toBe('BELOW')
})

test('main view: soonest expiry first, at most three, then +N more', SLOW, async ($, on) => {
  const names = ['a', 'b', 'c', 'd', 'e']
  const { clock } = rig(on, { agents: names.map(n => ({ id: `a${n}-1`, name: `agent-${n}` })) })
  // Requests at 0, 10, 20, 30, 40 s, in the order e, c, a, d, b.
  for (const n of ['e', 'c', 'a', 'd', 'b']) {
    await request($, clock, `a${n}-1`)
    await clock.advance(10_000)
  }
  await clock.set(100_000)
  const ui = await mount($)
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  agent-e 3:20 · agent-c 3:30 · agent-a 3:40 · +2 more')
  // At 250 s agent-e (expires 300 s) is in its last minute and draws in the warning color.
  await clock.set(250_000)
  await ui.redraw()
  const row = cacheRow(await ui.drawn())
  expect(row.children[1]).toMatchObject({ props: { color: 'warning' }, children: ['agent-e 0:50'] })
  expect(row.children[3]).toMatchObject({ props: { color: 'warning' }, children: ['agent-c 1:00'] })
  expect(row.children[5]).toMatchObject({ props: { dimColor: true }, children: ['agent-a 1:10'] })
})

test('agents inside a tool call or a model request are left out of the main view', SLOW, async ($, on) => {
  const { clock } = rig(on, {
    agents: [{ id: 'abusy-1', name: 'busy' }, { id: 'aidle-1', name: 'idle' }, { id: 'athink-1', name: 'think' }],
    toolMs: 30_000,
    responseMs: 0,
  })
  await request($, clock, 'abusy-1')
  await request($, clock, 'aidle-1')
  await request($, clock, 'athink-1')
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 30', agentId: 'abusy-1' } as any)
  await clock.settle()
  await clock.advance(10_000)
  const ui = await mount($)
  // Equal times fall back to name order.
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  idle 4:50 · think 4:50')
  await clock.advance(20_000)
  await call
  await ui.redraw()
  // The tool call ended at 30 s; busy's cache still counts from its request at 0.
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  busy 4:30 · idle 4:30 · think 4:30')
})

test('an agent waiting on its model response is working, not counting down', SLOW, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'reviewer-auth' }, { id: 'aidle-1', name: 'idle' }], responseMs: 5_000 })
  const first = step($, 'aidle-1')
  await clock.advance(5_000)
  await first
  const done = step($, 'arev-1')
  await clock.settle()
  const main = await mount($)
  expect(textOf(cacheRow(await main.drawn()))).toBe('cache  idle 4:55')
  const own = await mount($, { agentId: 'arev-1' })
  expect(textOf(cacheRow(await own.drawn()))).toBe('cache working · 5:00 left · 0')
  await clock.advance(5_000)
  await done
  await own.redraw()
  expect(textOf(cacheRow(await own.drawn()))).toBe('cache 4:55 left · 84K')
})

test("an agent's own view shows its countdown and expiry", async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'reviewer-auth' }] })
  await request($, clock, 'arev-1')
  await clock.set(120_000)
  const ui = await mount($, { agentId: 'arev-1' })
  let row = cacheRow(await ui.drawn())
  expect(textOf(row)).toBe('cache 3:00 left · 84K')
  expect(row.children[0].props).toMatchObject({ dimColor: true })
  await clock.set(250_000)
  await ui.redraw()
  row = cacheRow(await ui.drawn())
  expect(textOf(row)).toBe('cache 0:50 left · 84K')
  expect(row.children[0].props).toMatchObject({ color: 'warning' })
  await clock.set(420_000)
  await ui.redraw()
  row = cacheRow(await ui.drawn())
  expect(textOf(row)).toBe('cache expired 2 min ago · waking re-stores 84K')
  expect(row.children[0].props).toMatchObject({ color: 'error' })
  // Other mods' band output stays under the row.
  expect(textOf(await ui.drawn())).toBe('cache expired 2 min ago · waking re-stores 84KBELOW')
})

test('nothing is drawn when no agent qualifies', SLOW, async ($, on) => {
  // afork-1 is an engine fork: it makes requests but $.agent.list() never names it.
  const { clock } = rig(on, { agents: [{ id: 'agone-1', name: 'gone', status: 'killed' }] })
  await request($, clock, 'afork-1')
  await request($, clock, 'agone-1')
  const ui = await mount($)
  expect(cacheRow(await ui.drawn())).toBeUndefined()
  expect(textOf(await ui.drawn())).toBe('BELOW')
  // An untracked agent's own view draws nothing either.
  const other = await mount($, { agentId: 'anever-1' })
  expect(textOf(await other.drawn())).toBe('BELOW')
})

test('main_view off hides the main row and keeps the agent view', { options: { main_view: false } }, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await request($, clock, 'arev-1')
  expect(textOf(await (await mount($)).drawn())).toBe('BELOW')
  expect(textOf(cacheRow(await (await mount($, { agentId: 'arev-1' })).drawn()))).toBe('cache 5:00 left · 84K')
})

test('subagentPromptCacheTtl 1h gives an hour', async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], ttl: '1h' })
  await request($, clock, 'arev-1')
  await clock.set(301_000)
  expect(textOf(cacheRow(await (await mount($)).drawn()))).toBe('cache  rev 54:59')
})

test('ttl_seconds overrides the setting', { options: { ttl_seconds: 60 } }, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], ttl: '1h' })
  await request($, clock, 'arev-1')
  await clock.set(59_000)
  const ui = await mount($)
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  rev 0:01')
  await clock.set(61_000)
  await ui.redraw()
  expect(textOf(await ui.drawn())).toBe('BELOW')
})

test(
  'an error inside a helper draws nothing of ours, logs to debug, and never throws',
  {
    plugins: [
      {
        // Stands for corrupt state: every write of the tracks lands as one track with no fields.
        name: 'corrupt',
        register(on) {
          on('state.set', { plugin: 'cache', key: 'agents' }, ($, e, next) => next({ ...e, value: { 'arev-1': null } } as any))
        },
      },
    ],
  },
  async ($, on) => {
    const { clock, logs } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
    await request($, clock, 'arev-1')
    const ui = await mount($)
    expect(textOf(await ui.drawn())).toBe('BELOW')
    expect(logs.filter(l => l.startsWith('cache: ui.render: '))).toHaveLength(1)
  },
)

// ---- roster lookups, labels, setting reads, idle cost, stale working, robustness ----

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('an engine fork id is looked up once, however often it asks', async ($, on) => {
  const { clock, calls } = rig(on, { agents: [] })
  for (let i = 0; i < 5; i++) {
    await request($, clock, 'afork-1')
    await clock.advance(3_000)
  }
  expect(calls.list).toBe(1)
})

test('five fork ids inside two seconds make one lookup, a later one a second', SLOW, async ($, on) => {
  const { clock, calls } = rig(on, { agents: [] })
  for (let i = 0; i < 5; i++) await request($, clock, `afork-${i}`)
  expect(calls.list).toBe(1)
  await clock.advance(2_500)
  await request($, clock, 'afork-later')
  expect(calls.list).toBe(2)
})

test('a step ends without waiting for its roster lookup', async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], listMs: 10_000 })
  let finished = false
  const done = step($, 'arev-1').then(() => {
    finished = true
  })
  await clock.settle()
  expect(finished).toBe(true)
  await clock.advance(10_000)
  await done
})

test('a failing roster lookup is logged to debug and the step still completes', async ($, on) => {
  const { clock, logs, calls } = rig(on, { agents: [], listThrows: true })
  await request($, clock, 'afork-1')
  await clock.settle()
  expect(calls.steps).toBe(1)
  expect(logs.filter(l => l.startsWith('cache: agent.list: '))).toHaveLength(1)
})

test('two agents of one name are told apart by their ids', async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-9a39185e3c67fcf0', name: 'rev' }, { id: 'arev-77b0000000000001', name: 'rev' }] })
  await request($, clock, 'arev-9a39185e3c67fcf0')
  await request($, clock, 'arev-77b0000000000001')
  expect(textOf(cacheRow(await (await mount($)).drawn()))).toBe('cache  rev#9a39 5:00 · rev#77b0 5:00')
})

test('an agent without a name is labelled by its description, then by a short id', async ($, on) => {
  const { clock } = rig(on, {
    agents: [{ id: 'ad29b4d41c52644bb', description: 'Review the authentication module' }, { id: 'a34b8f081a325e7cc' }],
  })
  await request($, clock, 'ad29b4d41c52644bb')
  await request($, clock, 'a34b8f081a325e7cc')
  expect(textOf(cacheRow(await (await mount($)).drawn()))).toBe('cache  a34b8f08 5:00 · Review the authe 5:00')
})

test('completed and failed agents stay in the main view; killed ones go', async ($, on) => {
  const { clock } = rig(on, {
    agents: [{ id: 'adone-1', name: 'done', status: 'completed' }, { id: 'abad-1', name: 'bad', status: 'failed' }, { id: 'agone-1', name: 'gone', status: 'killed' }],
  })
  for (const id of ['adone-1', 'abad-1', 'agone-1']) await request($, clock, id)
  expect(textOf(cacheRow(await (await mount($)).drawn()))).toBe('cache  bad 5:00 · done 5:00')
})

test('a settings read that throws is not kept as the default and is retried', SLOW, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], ttl: '1h', settingsFailures: 1 })
  await request($, clock, 'arev-1')
  const ui = await mount($)
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  rev 5:00')
  await clock.set(400_000)
  await ui.redraw()
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  rev 53:20')
})

test('a settings read that throws leaves the value read before it in place', SLOW, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], ttl: '1h', settingsFailFrom: 2 })
  await request($, clock, 'arev-1')
  const ui = await mount($)
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  rev 1:00:00')
  await clock.set(400_000)
  await ui.redraw()
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  rev 53:20')
})

test('a failed settings read is retried at most every 30 s', async ($, on) => {
  const { clock, calls } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], settingsFailures: 2 })
  await request($, clock, 'arev-1')
  const ui = await mount($)
  await ui.drawn()
  expect(calls.settings).toBe(1)
  await clock.set(10_000)
  await ui.redraw()
  await ui.drawn()
  expect(calls.settings).toBe(1)
  await clock.set(31_000)
  await ui.redraw()
  await ui.drawn()
  expect(calls.settings).toBe(2)
})

test('a changed setting is picked up within 30 s', async ($, on) => {
  const { clock, setting } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await request($, clock, 'arev-1')
  const ui = await mount($)
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  rev 5:00')
  setting.ttl = '1h'
  await clock.set(100_000)
  await ui.redraw()
  await ui.drawn()
  await clock.set(200_000)
  await ui.redraw()
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  rev 56:40')
})

test('ticks with no agent tracked redraw nothing; with one they do', { plugins: [invalidations], ...SLOW }, async ($, on) => {
  const { clock, logs } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await $.session.start(START)
  await clock.advance(7_000)
  expect(logged(logs, 'invalidate')).toBe(0)
  await request($, clock, 'arev-1')
  await clock.advance(3_000)
  expect(logged(logs, 'invalidate')).toBeGreaterThan(0)
})

test('ticks stop redrawing once every track is expired and the last render drew nothing', { plugins: [invalidations], ...SLOWER }, async ($, on) => {
  const { clock, logs } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await $.session.start(START)
  await request($, clock, 'arev-1')
  await clock.set(400_000)
  const ui = await mount($)
  await ui.drawn()
  expect(cacheRow(await ui.drawn())).toBeUndefined()
  const before = logged(logs, 'invalidate')
  await clock.advance(10_000)
  expect(logged(logs, 'invalidate')).toBe(before)
  // A new request makes a track alive again, and the ticks resume.
  await request($, clock, 'arev-1')
  await clock.advance(3_000)
  expect(logged(logs, 'invalidate')).toBeGreaterThan(before)
})

test('the roster is written only when it changed', { plugins: [rosterWrites], ...SLOWER }, async ($, on) => {
  const { clock, logs } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await $.session.start(START)
  await request($, clock, 'arev-1')
  expect(logged(logs, 'write roster')).toBe(1)
  // Two roster refreshes on the tick (at 5 s and 10 s) find the same list.
  await clock.advance(11_000)
  expect(logged(logs, 'write roster')).toBe(1)
})

test('the roster refresh on the tick picks up a rename and a kill', SLOWER, async ($, on) => {
  const agents = [{ id: 'arev-1', name: 'old', status: 'idle' }]
  const { clock } = rig(on, { agents })
  await $.session.start(START)
  await request($, clock, 'arev-1')
  const ui = await mount($)
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  old 5:00')
  agents[0].name = 'renamed'
  await clock.advance(6_000)
  await ui.redraw()
  expect(textOf(cacheRow(await ui.drawn()))).toBe('cache  renamed 4:54')
  agents[0].status = 'killed'
  await clock.advance(5_000)
  await ui.redraw()
  expect(cacheRow(await ui.drawn())).toBeUndefined()
})

test('session.start clears the calls a reload dropped', SLOW, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], toolMs: 5_000 })
  await request($, clock, 'arev-1')
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 5', agentId: 'arev-1' } as any)
  await clock.settle()
  const own = await mount($, { agentId: 'arev-1' })
  expect(textOf(cacheRow(await own.drawn()))).toBe('cache working · 5:00 left · 84K')
  await $.session.start(START)
  await own.redraw()
  expect(textOf(cacheRow(await own.drawn()))).toBe('cache 5:00 left · 84K')
  await clock.advance(5_000)
  await call
})

test("an agent the roster lists as killed or failed is not shown as working in its own view", SLOW, async ($, on) => {
  const { clock } = rig(on, {
    agents: [{ id: 'akill-1', name: 'k', status: 'killed' }, { id: 'afail-1', name: 'f', status: 'failed' }],
    toolMs: 5_000,
  })
  await request($, clock, 'akill-1')
  await request($, clock, 'afail-1')
  const calls = [
    $.tool.call({ tool: 'Bash', command: 'x', agentId: 'akill-1' } as any),
    $.tool.call({ tool: 'Bash', command: 'x', agentId: 'afail-1' } as any),
  ]
  await clock.settle()
  for (const id of ['akill-1', 'afail-1']) {
    const own = await mount($, { agentId: id })
    expect(textOf(cacheRow(await own.drawn()))).toBe('cache 5:00 left · 84K')
  }
  await clock.advance(5_000)
  await Promise.all(calls)
})

test('a call in flight for 600 s or more is no longer shown as working', SLOW, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], toolMs: 1_000_000 })
  await request($, clock, 'arev-1')
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 1000', agentId: 'arev-1' } as any)
  await clock.settle()
  await clock.set(500_000)
  const own = await mount($, { agentId: 'arev-1' })
  expect(textOf(cacheRow(await own.drawn()))).toBe('cache working · expired 3 min ago · 84K')
  await clock.set(700_000)
  await own.redraw()
  expect(textOf(cacheRow(await own.drawn()))).toBe('cache expired 6 min ago · waking re-stores 84K')
  await clock.set(1_000_000)
  await call
})

test('a tool call is timed from when it began, not from the request before it', SLOW, async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }], ttl: '1h', toolMs: 1_000_000 })
  await request($, clock, 'arev-1')
  await clock.set(400_000)
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 1000', agentId: 'arev-1' } as any)
  await clock.settle()
  await clock.set(950_000)
  const own = await mount($, { agentId: 'arev-1' })
  expect(textOf(cacheRow(await own.drawn()))).toBe('cache working · 44:10 left · 84K')
  await clock.set(1_400_000)
  await call
})

test('an own view past an hour reads hours and minutes', async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await request($, clock, 'arev-1')
  await clock.set(300_000 + 130 * 60_000)
  expect(textOf(cacheRow(await (await mount($, { agentId: 'arev-1' })).drawn()))).toBe('cache expired 2 h 10 min ago · waking re-stores 84K')
})

test('a survey on screen leaves only the other mods\' output', async ($, on) => {
  const { clock } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await request($, clock, 'arev-1')
  expect(textOf(await (await mount($, {}, { hasSurvey: true })).drawn())).toBe('BELOW')
  expect(textOf(await (await mount($, { agentId: 'arev-1' }, { hasSurvey: true })).drawn())).toBe('BELOW')
})

test('a request or tool call with no agent id is not tracked', { plugins: [agentWrites] }, async ($, on) => {
  const { clock, logs } = rig(on, { agents: [] })
  const stream = $.turn.step({ turnId: 't-main', index: 0, model: 'm', messageCount: 1 })
  const drained = (async () => {
    for await (const _ of stream) {
      // forwarded chunks are not under test
    }
  })()
  const call = $.tool.call({ tool: 'Bash', command: 'x' } as any)
  await clock.settle()
  await drained
  await call
  expect(logged(logs, 'write agents')).toBe(0)
})

test('a state write that fails before the request leaves the stream working', { plugins: [firstAgentWriteFails] }, async ($, on) => {
  const { clock, logs, calls } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await request($, clock, 'arev-1')
  expect(calls.steps).toBe(1)
  expect(logs.filter(l => l.startsWith('cache: turn.step: '))).toHaveLength(1)
})

test('a state write that fails after the request leaves the stream and its end working', { plugins: [secondAgentWriteFails] }, async ($, on) => {
  const { clock, logs, calls } = rig(on, { agents: [{ id: 'arev-1', name: 'rev' }] })
  await request($, clock, 'arev-1')
  expect(calls.steps).toBe(1)
  expect(logs.filter(l => l.startsWith('cache: turn.step: '))).toHaveLength(1)
})
