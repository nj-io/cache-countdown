import { expect, test } from 'claude-code/testing'
import {
  agentLabel,
  anyLive,
  cacheStatus,
  clearInFlight,
  endRequest,
  formatAgo,
  formatClock,
  formatTokens,
  mainViewEntries,
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
