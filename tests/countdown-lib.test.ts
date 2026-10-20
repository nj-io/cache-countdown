import { expect, test } from 'claude-code/testing'
import {
  agentLabel,
  anyLive,
  cacheStatus,
  clearInFlight,
  compactAge,
  endRequest,
  formatAgo,
  formatClock,
  formatTokens,
  isPersonPrompt,
  keepAliveConfig,
  keepAliveDue,
  mainRequestStarted,
  mainTtlSeconds,
  mainViewEntries,
  mainViewSegments,
  personPrompted,
  pingFailed,
  pingSent,
  prune,
  rosterFrom,
  sameRoster,
  shiftInFlight,
  startRequest,
  ttlSeconds,
  viewedAgentSegments,
} from '../hooks/lib/countdown.mjs'

test('formatClock: m:ss, h:mm:ss from an hour, seconds rounded up', async () => {
  expect(formatClock(1)).toBe('0:01')
  expect(formatClock(1000)).toBe('0:01')
  expect(formatClock(192_000)).toBe('3:12')
  expect(formatClock(3_600_000)).toBe('1:00:00')
  expect(formatClock(-5)).toBe('0:00')
})

test('formatTokens: bare, K, M', async () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(84_000)).toBe('84K')
  expect(formatTokens(1_200_000)).toBe('1.2M')
  expect(formatTokens(2_000_000)).toBe('2M')
})

test('formatTokens: values that round up to the next unit move to it', async () => {
  expect(formatTokens(999_499)).toBe('999K')
  expect(formatTokens(999_500)).toBe('1M')
  expect(formatTokens(999_999)).toBe('1M')
  expect(formatTokens(999.4)).toBe('999')
  expect(formatTokens(999.6)).toBe('1K')
})

test('formatAgo: seconds under a minute, then whole minutes', async () => {
  expect(formatAgo(45_000)).toBe('45 s ago')
  expect(formatAgo(120_000)).toBe('2 min ago')
  expect(formatAgo(179_000)).toBe('2 min ago')
})

test('formatAgo: hours and minutes from sixty minutes', async () => {
  expect(formatAgo(59 * 60_000 + 59_000)).toBe('59 min ago')
  expect(formatAgo(60 * 60_000)).toBe('1 h ago')
  expect(formatAgo(130 * 60_000)).toBe('2 h 10 min ago')
})

test('ttlSeconds: option, then the 1h setting, then 300', async () => {
  expect(ttlSeconds(undefined, undefined)).toBe(300)
  expect(ttlSeconds('5m', undefined)).toBe(300)
  expect(ttlSeconds('1h', undefined)).toBe(3600)
  expect(ttlSeconds('1h', 60)).toBe(60)
  expect(ttlSeconds(undefined, 0)).toBe(300)
})

test('cacheStatus: the last request time plus the lifetime, exclusive', async () => {
  const track = { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }
  expect(cacheStatus(track, 299_999, 300_000)).toEqual({ kind: 'alive', remainingMs: 1 })
  expect(cacheStatus(track, 300_000, 300_000)).toEqual({ kind: 'expired', expiredForMs: 0 })
  expect(cacheStatus({ ...track, inFlight: 1 }, 400_000, 300_000)).toEqual({ kind: 'working' })
})

test('cacheStatus: never more than a full lifetime left when the clock went backwards', async () => {
  const track = { lastRequestAt: 100_000, contextTokens: 1, inFlight: 0 }
  expect(cacheStatus(track, 40_000, 300_000)).toEqual({ kind: 'alive', remainingMs: 300_000 })
})

test('cacheStatus: working needs a live roster status and a call begun within 600 s', async () => {
  const busy = { lastRequestAt: 0, contextTokens: 1, inFlight: 1, workingSince: 0 }
  expect(cacheStatus(busy, 599_999, 300_000, 'running')).toEqual({ kind: 'working' })
  expect(cacheStatus(busy, 600_000, 300_000, 'running')).toEqual({ kind: 'expired', expiredForMs: 300_000 })
  expect(cacheStatus(busy, 100_000, 300_000, 'killed')).toEqual({ kind: 'alive', remainingMs: 200_000 })
  expect(cacheStatus(busy, 100_000, 300_000, 'failed')).toEqual({ kind: 'alive', remainingMs: 200_000 })
  expect(cacheStatus(busy, 100_000, 300_000, 'completed')).toEqual({ kind: 'working' })
})

test('startRequest and endRequest count calls in flight and keep the last context size', async () => {
  let agents = startRequest({}, 'a1', 1000)
  expect(agents.a1).toEqual({ lastRequestAt: 1000, contextTokens: 0, inFlight: 1, workingSince: 1000 })
  agents = endRequest(agents, 'a1', 84_000)
  expect(agents.a1).toEqual({ lastRequestAt: 1000, contextTokens: 84_000, inFlight: 0 })
  agents = endRequest(startRequest(agents, 'a1', 2000), 'a1', undefined)
  expect(agents.a1).toEqual({ lastRequestAt: 2000, contextTokens: 84_000, inFlight: 0 })
})

test('workingSince is when the in-flight count rose from zero, and goes when it returns to zero', async () => {
  let agents = startRequest({}, 'a1', 1000)
  agents = shiftInFlight(agents, 'a1', 1, 5000)
  expect(agents.a1).toMatchObject({ inFlight: 2, workingSince: 1000, lastRequestAt: 1000 })
  agents = shiftInFlight(shiftInFlight(agents, 'a1', -1), 'a1', -1)
  expect(agents.a1).toEqual({ lastRequestAt: 1000, contextTokens: 0, inFlight: 0 })
  agents = shiftInFlight(agents, 'a1', 1, 9000)
  expect(agents.a1.workingSince).toBe(9000)
  expect(clearInFlight(agents).a1).toEqual({ lastRequestAt: 1000, contextTokens: 0, inFlight: 0 })
})

test('mainViewEntries skips agents the roster does not list or lists as killed', async () => {
  const agents = { a1: { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }, a2: { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }, a3: { lastRequestAt: 0, contextTokens: 1, inFlight: 0 } }
  const roster = { a1: { name: 'one', status: 'idle' }, a2: { name: 'two', status: 'killed' } }
  expect(mainViewEntries(agents, roster, 1000, 300_000)).toEqual({ shown: [{ id: 'a1', label: 'one', remainingMs: 299_000 }], more: 0 })
})

test('mainViewEntries keeps completed and failed agents, and tells same-named agents apart', async () => {
  const track = { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }
  const agents = { a1: track, a2: track, a3: track, a4: track }
  const roster = {
    a1: { name: 'one', status: 'completed' },
    a2: { name: 'two', status: 'failed' },
    a3: { name: 'two', status: 'idle' },
    a4: { name: 'gone', status: 'killed' },
  }
  expect(mainViewEntries(agents, roster, 1000, 300_000)).toEqual({
    shown: [
      { id: 'a1', label: 'one', remainingMs: 299_000 },
      { id: 'a2', label: 'two#2', remainingMs: 299_000 },
      { id: 'a3', label: 'two#3', remainingMs: 299_000 },
    ],
    more: 0,
  })
})

test('same-named agents are told apart by the first four characters of the id after the name', async () => {
  const track = { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }
  const agents = { 'arev-9a39185e3c67fcf0': track, 'arev-77b0000000000001': track, 'ad29b4d41c52644bb': track, 'a34b8f081a325e7cc': track }
  const roster = Object.fromEntries(Object.keys(agents).map(id => [id, { name: id.startsWith('arev') ? 'rev' : undefined, description: 'Check', status: 'idle' }]))
  const labels = mainViewEntries(agents, roster, 1000, 300_000, 10).shown.map((e: any) => e.label)
  expect(labels).toEqual(['Check#d29b', 'Check#34b8', 'rev#9a39', 'rev#77b0'])
})

test('agentLabel: the name, else the description cut to 16 characters, else a short id', async () => {
  expect(agentLabel('a1234567890', { a1234567890: { name: 'rev', description: 'Review things', status: 'idle' } })).toBe('rev')
  expect(agentLabel('a1234567890', { a1234567890: { description: 'Review the authentication module', status: 'idle' } })).toBe('Review the authe')
  expect(agentLabel('a1234567890', { a1234567890: { description: 'Short one', status: 'idle' } })).toBe('Short one')
  expect(agentLabel('a1234567890', { a1234567890: { description: '  ', status: 'idle' } })).toBe('a1234567')
  expect(agentLabel('a1234567890', {})).toBe('a1234567')
})

test('tracks without a finite request time are skipped', async () => {
  const good = { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }
  const agents = { a1: good, a2: { ...good, lastRequestAt: NaN }, a3: { contextTokens: 1, inFlight: 0 } }
  const roster = { a1: { name: 'one', status: 'idle' }, a2: { name: 'two', status: 'idle' }, a3: { name: 'three', status: 'idle' } }
  expect(mainViewEntries(agents, roster, 1000, 300_000).shown.map((e: any) => e.id)).toEqual(['a1'])
  expect(viewedAgentSegments(agents.a2, 1000, 300_000, 'idle')).toBeUndefined()
  expect(viewedAgentSegments(agents.a3 as any, 1000, 300_000, 'idle')).toBeUndefined()
})

test('rosterFrom keeps name, description and status; sameRoster compares them', async () => {
  const roster = rosterFrom([{ id: 'a1', name: 'one', description: 'D', status: 'idle', type: 'x' }])
  expect(roster).toEqual({ a1: { name: 'one', description: 'D', status: 'idle' } })
  expect(sameRoster(roster, rosterFrom([{ id: 'a1', name: 'one', description: 'D', status: 'idle' }]))).toBe(true)
  expect(sameRoster(roster, rosterFrom([{ id: 'a1', name: 'two', description: 'D', status: 'idle' }]))).toBe(false)
  expect(sameRoster(roster, rosterFrom([{ id: 'a1', name: 'one', description: 'D', status: 'killed' }]))).toBe(false)
  expect(sameRoster(roster, rosterFrom([{ id: 'a1', name: 'one', description: 'E', status: 'idle' }]))).toBe(false)
  expect(sameRoster(roster, {})).toBe(false)
  expect(sameRoster(roster, rosterFrom([{ id: 'a2', name: 'one', description: 'D', status: 'idle' }]))).toBe(false)
})

test('prune drops tracks idle a day, keeps busy ones', async () => {
  const day = 24 * 3600_000
  const agents = { old: { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }, busy: { lastRequestAt: 0, contextTokens: 1, inFlight: 1 }, fresh: { lastRequestAt: day, contextTokens: 1, inFlight: 0 } }
  expect(Object.keys(prune(agents, day + 1))).toEqual(['busy', 'fresh'])
})

test('viewedAgentSegments: working shows the cache clock, alive or expired, with the tokens', async () => {
  const busy = { lastRequestAt: 0, contextTokens: 47_000, inFlight: 1, workingSince: 0 }
  expect(viewedAgentSegments(busy, 288_000, 300_000, 'running')).toEqual([{ text: 'cache working · 0:12 left · 47K', tone: 'dim' }])
  expect(viewedAgentSegments(busy, 480_000, 300_000, 'running')).toEqual([{ text: 'cache working · expired 3 min ago · 47K', tone: 'dim' }])
})

test('anyLive: true for an alive or working track, false when every track is expired or unfinite', async () => {
  const idle = { lastRequestAt: 0, contextTokens: 1, inFlight: 0 }
  const busy = { ...idle, inFlight: 1, workingSince: 400_000 }
  expect(anyLive({ a1: idle }, {}, 100_000, 300_000)).toBe(true)
  expect(anyLive({ a1: idle }, {}, 300_000, 300_000)).toBe(false)
  expect(anyLive({ a1: idle, a2: busy }, {}, 450_000, 300_000)).toBe(true)
  expect(anyLive({ a1: { ...idle, lastRequestAt: NaN } }, {}, 1000, 300_000)).toBe(false)
  expect(anyLive({}, {}, 0, 300_000)).toBe(false)
})

// ---- the main session's own entry ----

const MAIN_TTL = 3_600_000
const HOUR = 3_600_000
const idleTrack = (lastRequestAt: number) => ({ lastRequestAt, contextTokens: 1, inFlight: 0 })
const rowText = (segments: any) => segments?.map((s: any) => s.text).join('')

test('compactAge: whole minutes under an hour, hours under 48 h, then days, floored', async () => {
  expect(compactAge(0)).toBe('0m')
  expect(compactAge(59_999)).toBe('0m')
  expect(compactAge(12 * 60_000 + 59_000)).toBe('12m')
  expect(compactAge(59 * 60_000 + 59_000)).toBe('59m')
  expect(compactAge(HOUR)).toBe('1h')
  expect(compactAge(3 * HOUR + 59 * 60_000)).toBe('3h')
  expect(compactAge(48 * HOUR - 1)).toBe('47h')
  expect(compactAge(48 * HOUR)).toBe('2d')
  expect(compactAge(5 * 24 * HOUR + 23 * HOUR)).toBe('5d')
  expect(compactAge(-5)).toBe('0m')
})

test('mainTtlSeconds: the option when positive, else 3600', async () => {
  expect(mainTtlSeconds(undefined)).toBe(3600)
  expect(mainTtlSeconds(300)).toBe(300)
  expect(mainTtlSeconds(0)).toBe(3600)
  expect(mainTtlSeconds(NaN)).toBe(3600)
  expect(mainTtlSeconds('300' as any)).toBe(3600)
})

test('mainViewSegments: the main session leads the row with its clock', async () => {
  // Requests at 0 (main), 516 s, 600 s, 667 s and 700 s; now is 775 s.
  const agents = { main: idleTrack(0), a1: idleTrack(516_000), a2: idleTrack(600_000), a3: idleTrack(667_000), a4: idleTrack(700_000) }
  const roster = { a1: { name: 'rev-ui', status: 'idle' }, a2: { name: 'reader', status: 'idle' }, a3: { name: 'fix-db', status: 'idle' }, a4: { name: 'other', status: 'idle' } }
  const segments = mainViewSegments(agents, roster, 775_000, 300_000, 3, MAIN_TTL)
  expect(rowText(segments)).toBe('cache  main 47:05 · rev-ui 0:41 · reader 2:05 · fix-db 3:12 · +1 more')
  expect(segments[1]).toEqual({ text: 'main 47:05', tone: 'dim' })
  expect(rowText(mainViewSegments({ main: idleTrack(0) }, {}, 775_000, 300_000, 3, MAIN_TTL))).toBe('cache  main 47:05')
})

test('mainViewSegments: main turns amber in its last minute', async () => {
  expect(mainViewSegments({ main: idleTrack(0) }, {}, MAIN_TTL - 60_000, 300_000, 3, MAIN_TTL)[1]).toEqual({ text: 'main 1:00', tone: 'warn' })
  expect(mainViewSegments({ main: idleTrack(0) }, {}, MAIN_TTL - 60_001, 300_000, 3, MAIN_TTL)[1].tone).toBe('dim')
})

test('mainViewSegments: an expired main shows its age in the expired tone', async () => {
  // Main expired at 300 s on a 300 s lifetime; now is 1050 s, 12.5 minutes later.
  const agents = { main: idleTrack(0), a2: idleTrack(875_000) }
  const roster = { a2: { name: 'reader', status: 'idle' } }
  const segments = mainViewSegments(agents, roster, 1_050_000, 300_000, 3, 300_000)
  expect(rowText(segments)).toBe('cache  main expired 12m · reader 2:05')
  expect(segments[1]).toEqual({ text: 'main expired 12m', tone: 'expired' })
  expect(rowText(mainViewSegments({ main: idleTrack(0) }, {}, 1_050_000, 300_000, 3, 300_000))).toBe('cache  main expired 12m')
})

test('mainViewSegments: main sits outside the cap and the +N more count', async () => {
  const roster: Record<string, any> = {}
  const agents: Record<string, any> = { main: idleTrack(400_000) }
  // Four working, two expired, four alive; the alive four are a-alpha..a-delta.
  for (const n of ['w1', 'w2', 'w3', 'w4']) {
    agents[n] = { ...idleTrack(400_000), inFlight: 1, workingSince: 400_000 }
    roster[n] = { name: n, status: 'running' }
  }
  for (const n of ['e1', 'e2']) {
    agents[n] = idleTrack(0)
    roster[n] = { name: n, status: 'idle' }
  }
  for (const n of ['alpha', 'bravo', 'charlie', 'delta']) {
    agents[n] = idleTrack(400_000)
    roster[n] = { name: n, status: 'idle' }
  }
  expect(rowText(mainViewSegments(agents, roster, 400_000, 300_000, 3, MAIN_TTL))).toBe('cache  main 1:00:00 · alpha 5:00 · bravo 5:00 · charlie 5:00 · +1 more')
})

test('mainViewSegments: a working or never-seen main has no entry', async () => {
  const roster = { a1: { name: 'reader', status: 'idle' } }
  expect(rowText(mainViewSegments({ main: idleTrack(0), a1: idleTrack(0) }, roster, 100_000, 300_000, 3, MAIN_TTL))).toBe('cache  main 58:20 · reader 3:20')
  const busy = { main: { ...idleTrack(0), inFlight: 1, workingSince: 0 }, a1: idleTrack(0) }
  expect(rowText(mainViewSegments(busy, roster, 100_000, 300_000, 3, MAIN_TTL))).toBe('cache  reader 3:20')
  expect(rowText(mainViewSegments({ a1: idleTrack(0) }, roster, 100_000, 300_000, 3, MAIN_TTL))).toBe('cache  reader 3:20')
  expect(mainViewSegments({ main: { ...idleTrack(0), inFlight: 1, workingSince: 0 } }, {}, 100_000, 300_000, 3, MAIN_TTL)).toBeUndefined()
  expect(mainViewSegments({}, {}, 100_000, 300_000, 3, MAIN_TTL)).toBeUndefined()
  expect(mainViewSegments({ main: idleTrack(NaN) }, {}, 100_000, 300_000, 3, MAIN_TTL)).toBeUndefined()
})

test('mainViewSegments: the main lifetime is its own, not the agents\'', async () => {
  const agents = { main: idleTrack(0) }
  // 100 s in: a 300 s agent lifetime would leave 3:20; the main lifetime of 60 s has run out.
  expect(rowText(mainViewSegments(agents, {}, 100_000, 300_000, 3, 60_000))).toBe('cache  main expired 0m')
  expect(rowText(mainViewSegments(agents, {}, 40_000, 3_600_000, 3, 60_000))).toBe('cache  main 0:20')
})

test('mainViewEntries ignores the main key, even when the roster lists an agent under it', async () => {
  const agents = { main: idleTrack(0), a1: idleTrack(0) }
  const roster = { main: { name: 'main', status: 'idle' }, a1: { name: 'one', status: 'idle' } }
  expect(mainViewEntries(agents, roster, 1000, 300_000).shown.map((e: any) => e.id)).toEqual(['a1'])
})

test('anyLive counts the main session on its own lifetime', async () => {
  const agents = { main: idleTrack(0) }
  expect(anyLive(agents, {}, 100_000, 60_000, MAIN_TTL)).toBe(true)
  expect(anyLive(agents, {}, 100_000, 300_000, 60_000)).toBe(false)
  expect(anyLive({ main: { ...idleTrack(0), inFlight: 1, workingSince: 90_000 } }, {}, 100_000, 300_000, 60_000)).toBe(true)
})

test('prune keeps the main track however old', async () => {
  const day = 24 * HOUR
  const agents = { main: idleTrack(0), old: idleTrack(0) }
  expect(Object.keys(prune(agents, 3 * day))).toEqual(['main'])
  expect(Object.keys(startRequest(agents, 'a1', 3 * day)).sort()).toEqual(['a1', 'main'])
})

// ---- keep-alive ping ----

const ON = { keep_alive: true, keep_alive_minutes: 58, keep_alive_max: 3 }
const NONE = { pings: 0, pending: false }

test('keepAliveConfig: the options, with the defaults for anything missing or out of range', async () => {
  expect(keepAliveConfig(ON, MAIN_TTL)).toEqual({ isOn: true, idleMs: 58 * 60_000, max: 3 })
  expect(keepAliveConfig({}, MAIN_TTL)).toEqual({ isOn: false, idleMs: 58 * 60_000, max: 3 })
  expect(keepAliveConfig({ keep_alive: false }, MAIN_TTL).isOn).toBe(false)
  expect(keepAliveConfig({ keep_alive: true, keep_alive_minutes: 0, keep_alive_max: 0 }, MAIN_TTL)).toMatchObject({ idleMs: 58 * 60_000, max: 3 })
  expect(keepAliveConfig({ keep_alive: true, keep_alive_minutes: 10, keep_alive_max: 5 }, MAIN_TTL)).toMatchObject({ idleMs: 600_000, max: 5 })
})

test('keepAliveConfig: an idle time at or over the main lifetime becomes the lifetime less a minute, never below 0', async () => {
  expect(keepAliveConfig({ ...ON, keep_alive_minutes: 58 }, 3_000_000).idleMs).toBe(2_940_000)
  expect(keepAliveConfig({ ...ON, keep_alive_minutes: 60 }, MAIN_TTL).idleMs).toBe(MAIN_TTL - 60_000)
  expect(keepAliveConfig({ ...ON, keep_alive_minutes: 59 }, MAIN_TTL).idleMs).toBe(59 * 60_000)
  expect(keepAliveConfig({ ...ON, keep_alive_minutes: 5 }, 300_000).idleMs).toBe(240_000)
  expect(keepAliveConfig({ ...ON, keep_alive_minutes: 1 }, 30_000).idleMs).toBe(0)
})

test('keepAliveDue: at the idle threshold and not a millisecond before', async () => {
  const cfg = keepAliveConfig(ON, MAIN_TTL)
  const agents = { main: idleTrack(1000) }
  expect(keepAliveDue(agents, NONE, cfg, 1000 + 58 * 60_000 - 1, MAIN_TTL)).toBe(false)
  expect(keepAliveDue(agents, NONE, cfg, 1000 + 58 * 60_000, MAIN_TTL)).toBe(true)
})

test('keepAliveDue: not when the option is off, nothing is tracked, or the cache has expired', async () => {
  const agents = { main: idleTrack(0) }
  const at = 58 * 60_000
  expect(keepAliveDue(agents, NONE, keepAliveConfig({ ...ON, keep_alive: false }, MAIN_TTL), at, MAIN_TTL)).toBe(false)
  expect(keepAliveDue({}, NONE, keepAliveConfig(ON, MAIN_TTL), at, MAIN_TTL)).toBe(false)
  expect(keepAliveDue({ a1: idleTrack(0) }, NONE, keepAliveConfig(ON, MAIN_TTL), at, MAIN_TTL)).toBe(false)
  expect(keepAliveDue({ main: idleTrack(NaN) }, NONE, keepAliveConfig(ON, MAIN_TTL), at, MAIN_TTL)).toBe(false)
  expect(keepAliveDue(agents, NONE, keepAliveConfig(ON, MAIN_TTL), MAIN_TTL - 1, MAIN_TTL)).toBe(true)
  expect(keepAliveDue(agents, NONE, keepAliveConfig(ON, MAIN_TTL), MAIN_TTL, MAIN_TTL)).toBe(false)
})

test('keepAliveDue: not while the main session is working', async () => {
  // A tool call began a second ago on a request that is otherwise old enough to ping after.
  const busy = { main: { ...idleTrack(0), inFlight: 1, workingSince: 58 * 60_000 - 1000 } }
  expect(keepAliveDue({ main: idleTrack(0) }, NONE, keepAliveConfig(ON, MAIN_TTL), 58 * 60_000, MAIN_TTL)).toBe(true)
  expect(keepAliveDue(busy, NONE, keepAliveConfig(ON, MAIN_TTL), 58 * 60_000, MAIN_TTL)).toBe(false)
})

test('keepAliveDue: not at the maximum in a row, nor while a ping is pending', async () => {
  const agents = { main: idleTrack(0) }
  const cfg = keepAliveConfig(ON, MAIN_TTL)
  const at = 58 * 60_000
  expect(keepAliveDue(agents, { pings: 2, pending: false }, cfg, at, MAIN_TTL)).toBe(true)
  expect(keepAliveDue(agents, { pings: 3, pending: false }, cfg, at, MAIN_TTL)).toBe(false)
  expect(keepAliveDue(agents, { pings: 0, pending: true }, cfg, at, MAIN_TTL)).toBe(false)
})

test('keepAliveDue: a clamped threshold still waits for the cache to be idle that long', async () => {
  const cfg = keepAliveConfig({ ...ON, keep_alive_minutes: 5 }, 300_000)
  const agents = { main: idleTrack(0) }
  expect(keepAliveDue(agents, NONE, cfg, 239_999, 300_000)).toBe(false)
  expect(keepAliveDue(agents, NONE, cfg, 240_000, 300_000)).toBe(true)
})

test('isPersonPrompt: only the composer, the bridge and a Slack ping, over every PromptOrigin kind', async () => {
  const people = ['composer', 'bridge', 'slack-ping']
  const others = [
    'sdk',
    'task-notification',
    'scheduled-trigger',
    'peer',
    'peer-send-message',
    'projects-relay',
    'channel',
    'coordinator',
    'observer',
    'observer-activity',
    'auto-continuation',
    'unclassified',
    'plugin',
  ]
  for (const kind of people) expect(isPersonPrompt({ kind })).toBe(true)
  for (const kind of others) expect(isPersonPrompt({ kind })).toBe(false)
  expect(isPersonPrompt({ kind: 'plugin', name: 'cache' })).toBe(false)
  expect(isPersonPrompt({ kind: 'plugin', name: 'other', asUser: true })).toBe(false)
  expect(isPersonPrompt({ kind: 'channel', server: 'slack' })).toBe(false)
  expect(isPersonPrompt(undefined)).toBe(false)
})

test('keep-alive state: a ping counts and waits, a refused one is not counted, a main request ends the wait, a person resets the count', async () => {
  const sent = pingSent(NONE)
  expect(sent).toEqual({ pings: 1, pending: true })
  expect(pingFailed(sent)).toEqual({ pings: 0, pending: true })
  expect(pingFailed(NONE)).toEqual({ pings: 0, pending: true })
  expect(mainRequestStarted(sent)).toEqual({ pings: 1, pending: false })
  expect(mainRequestStarted(NONE)).toBe(NONE)
  expect(personPrompted({ pings: 2, pending: true })).toEqual({ pings: 0, pending: true })
  expect(personPrompted(NONE)).toBe(NONE)
})

test('mainViewSegments: a kept-alive main reads its pings after the clock', async () => {
  const kept = { count: 1, max: 3 }
  const roster = { a1: { name: 'reader', status: 'idle' } }
  const segments = mainViewSegments({ main: idleTrack(2000) }, {}, 4000, 300_000, 3, MAIN_TTL, kept)
  expect(rowText(segments)).toBe('cache  main 59:58 · kept alive 1/3')
  expect(segments[1]).toEqual({ text: 'main 59:58 · kept alive 1/3', tone: 'dim' })
  expect(rowText(mainViewSegments({ main: idleTrack(0), a1: idleTrack(125_000) }, { a1: roster.a1 }, 180_000, 300_000, 3, MAIN_TTL, kept))).toBe('cache  main 57:00 · kept alive 1/3 · reader 4:05')
  expect(rowText(mainViewSegments({ main: idleTrack(2000) }, {}, 4000, 300_000, 3, MAIN_TTL, { count: 0, max: 3 }))).toBe('cache  main 59:58')
  expect(rowText(mainViewSegments({ main: idleTrack(2000) }, {}, 4000, 300_000, 3, MAIN_TTL))).toBe('cache  main 59:58')
})

test('mainViewSegments: an expired main shows its age without the pings', async () => {
  expect(rowText(mainViewSegments({ main: idleTrack(0) }, {}, 3_600_000 + 12 * 60_000, 300_000, 3, MAIN_TTL, { count: 3, max: 3 }))).toBe('cache  main expired 12m')
})
