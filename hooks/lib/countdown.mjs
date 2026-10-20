// Pure helpers for the cache countdown: no `$`, no clock of their own, so the
// hooks module and plain unit tests call them with the same inputs.

export const DEFAULT_TTL_S = 300;
export const LONG_TTL_S = 3600;
export const MAIN_VIEW_CAP = 3;
// Remaining time at or under this draws in the warning color.
export const WARN_MS = 60_000;
// Tracks idle longer than this are dropped from state (engine forks leave one per prompt).
export const PRUNE_AFTER_MS = 24 * 3600_000;
// A call in flight longer than this is taken as one whose end was never reported.
export const WORKING_MAX_MS = 600_000;
const LABEL_DESCRIPTION_CHARS = 16;
const STORED_DESCRIPTION_CHARS = 64;

/**
 * Cache lifetime in seconds: the `ttl_seconds` option when set, else the
 * user's `subagentPromptCacheTtl` setting ('1h' → 3600), else 300.
 */
export function ttlSeconds(settingValue, optionValue) {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue > 0) return optionValue;
  return settingValue === '1h' ? LONG_TTL_S : DEFAULT_TTL_S;
}

/** Context size of one request: everything the model read, cached or not. */
export function contextTokens(usage) {
  if (!usage) return undefined;
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** `m:ss`, or `h:mm:ss` from an hour up; whole seconds rounded up. */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `84K`, `1.2M`, or the bare number under a thousand. */
export function formatTokens(n) {
  // The cut-offs sit at the rounding points: 999.6 is `1K` and 999_999 is `1M`, never `1000` or `1000K`.
  if (!Number.isFinite(n) || n < 999.5) return String(Math.max(0, Math.round(n || 0)));
  if (n < 999_500) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** How long ago the cache expired: `45 s ago`, `2 min ago`, `2 h 10 min ago`. */
export function formatAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const rest = min % 60;
  return rest === 0 ? `${Math.floor(min / 60)} h ago` : `${Math.floor(min / 60)} h ${rest} min ago`;
}

/** An agent's label: its name from `$.agent.list()`, else its description cut short, else a short id. */
export function agentLabel(id, roster) {
  const entry = roster?.[id];
  if (typeof entry?.name === 'string' && entry.name) return entry.name;
  const description = typeof entry?.description === 'string' ? entry.description.trim().slice(0, LABEL_DESCRIPTION_CHARS).trimEnd() : '';
  return description || id.slice(0, 8);
}

/** What tells two agents' ids apart: the first four characters after the leading `a` and any `<name>-` prefix. */
function idTail(id) {
  const rest = id.replace(/^a/, '');
  return rest.slice(rest.lastIndexOf('-') + 1, rest.lastIndexOf('-') + 5);
}

/** Entries that share a label get `#` and their id's tail, so two agents of one name read apart. */
function tellApart(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  return entries.map(entry => (counts.get(entry.label) > 1 ? { ...entry, label: `${entry.label}#${idTail(entry.id)}` } : entry));
}

/**
 * Where one agent's cache stands at `now`: working, alive, or expired. A call
 * counts as working only while the roster does not list the agent as dead and
 * it began within `WORKING_MAX_MS`; a count left over from a lost report
 * then falls back to the cache's own clock.
 */
export function cacheStatus(track, now, ttlMs, rosterStatus) {
  const isDead = rosterStatus === 'killed' || rosterStatus === 'failed';
  if (track.inFlight > 0 && !isDead && now - (track.workingSince ?? track.lastRequestAt) < WORKING_MAX_MS) {
    return { kind: 'working' };
  }
  const expiresAt = track.lastRequestAt + ttlMs;
  // A clock that went backwards never shows more than a full lifetime.
  return now < expiresAt
    ? { kind: 'alive', remainingMs: Math.min(ttlMs, expiresAt - now) }
    : { kind: 'expired', expiredForMs: now - expiresAt };
}

/** Whether any track is working or has cache left at `now`; when none does, only an expired line can still be on screen. */
export function anyLive(agents, roster, now, ttlMs) {
  return Object.entries(agents).some(([id, track]) => Number.isFinite(track.lastRequestAt) && cacheStatus(track, now, ttlMs, roster[id]?.status).kind !== 'expired');
}

export function toneFor(remainingMs) {
  return remainingMs > WARN_MS ? 'dim' : 'warn';
}

/**
 * Agents for the main view: listed by `$.agent.list()` and not killed (engine
 * forks never are; finished and failed agents stay, they can be resumed), not
 * working, cache still alive; soonest expiry first, at most `cap`, the rest
 * counted in `more`. A track without a finite request time never counts as alive.
 */
export function mainViewEntries(agents, roster, now, ttlMs, cap = MAIN_VIEW_CAP) {
  const alive = [];
  for (const [id, track] of Object.entries(agents)) {
    const listed = roster[id];
    if (!listed || listed.status === 'killed') continue;
    const status = cacheStatus(track, now, ttlMs, listed.status);
    if (status.kind !== 'alive') continue;
    alive.push({ id, label: agentLabel(id, roster), remainingMs: status.remainingMs });
  }
  alive.sort((a, b) => a.remainingMs - b.remainingMs || a.label.localeCompare(b.label));
  return { shown: tellApart(alive.slice(0, cap)), more: Math.max(0, alive.length - cap) };
}

/**
 * The main view's row as text segments, each with a tone the hook maps to
 * Text props; undefined when no agent qualifies.
 */
export function mainViewSegments(agents, roster, now, ttlMs, cap = MAIN_VIEW_CAP) {
  const { shown, more } = mainViewEntries(agents, roster, now, ttlMs, cap);
  if (shown.length === 0) return undefined;
  const segments = [{ text: 'cache  ', tone: 'dim' }];
  shown.forEach((entry, i) => {
    if (i > 0) segments.push({ text: ' · ', tone: 'dim' });
    segments.push({ text: `${entry.label} ${formatClock(entry.remainingMs)}`, tone: toneFor(entry.remainingMs) });
  });
  if (more > 0) segments.push({ text: ` · +${more} more`, tone: 'dim' });
  return segments;
}

/** The row for one agent's own view; undefined when the agent is not tracked. */
export function viewedAgentSegments(track, now, ttlMs, rosterStatus) {
  if (!track || !Number.isFinite(track.lastRequestAt)) return undefined;
  const tokens = formatTokens(track.contextTokens ?? 0);
  const status = cacheStatus(track, now, ttlMs, rosterStatus);
  if (status.kind === 'working') {
    // The cache's own clock runs under the call.
    const expiresAt = track.lastRequestAt + ttlMs;
    const clock = now < expiresAt ? `${formatClock(Math.min(ttlMs, expiresAt - now))} left` : `expired ${formatAgo(now - expiresAt)}`;
    return [{ text: `cache working · ${clock} · ${tokens}`, tone: 'dim' }];
  }
  if (status.kind === 'alive') {
    return [{ text: `cache ${formatClock(status.remainingMs)} left · ${tokens}`, tone: toneFor(status.remainingMs) }];
  }
  return [{ text: `cache expired ${formatAgo(status.expiredForMs)} · waking re-stores ${tokens}`, tone: 'expired' }];
}

/** A track with its in-flight count set; `workingSince` is when the count last rose from zero. */
function withInFlight(track, inFlight, now) {
  const { workingSince, ...rest } = track;
  if (inFlight === 0) return { ...rest, inFlight };
  return { ...rest, inFlight, workingSince: track.inFlight > 0 ? (workingSince ?? now) : now };
}

/** State after a request starts: its time recorded, one more call in flight. */
export function startRequest(agents, id, now) {
  const track = agents[id] ?? { lastRequestAt: now, contextTokens: 0, inFlight: 0 };
  return prune({ ...agents, [id]: { ...withInFlight(track, track.inFlight + 1, now), lastRequestAt: now } }, now);
}

/** State after a request ends: one fewer in flight, the context size when the response carried usage. */
export function endRequest(agents, id, tokens) {
  const track = agents[id];
  if (!track) return agents;
  return {
    ...agents,
    [id]: { ...withInFlight(track, Math.max(0, track.inFlight - 1)), contextTokens: tokens ?? track.contextTokens },
  };
}

/** State after a tool call starts (delta 1, at `now`) or ends (delta -1). */
export function shiftInFlight(agents, id, delta, now) {
  const track = agents[id];
  if (!track) return agents;
  return { ...agents, [id]: withInFlight(track, Math.max(0, track.inFlight + delta), now) };
}

/** Every in-flight count back to zero: the calls a reload dropped never report back. */
export function clearInFlight(agents) {
  const out = {};
  for (const [id, track] of Object.entries(agents)) out[id] = withInFlight(track, 0);
  return out;
}

export function prune(agents, now, keepMs = PRUNE_AFTER_MS) {
  const out = {};
  for (const [id, track] of Object.entries(agents)) {
    if (track.inFlight > 0 || now - track.lastRequestAt <= keepMs) out[id] = track;
  }
  return out;
}

/** `$.agent.list()` rows as `{ id: { name, description, status } }`. */
export function rosterFrom(list) {
  const out = {};
  for (const row of list) {
    const description = typeof row.description === 'string' ? row.description.slice(0, STORED_DESCRIPTION_CHARS) : undefined;
    out[row.id] = { name: row.name, description, status: row.status };
  }
  return out;
}

/** Whether two rosters hold the same agents with the same name, description and status. */
export function sameRoster(a, b) {
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  return ids.every(id => {
    const x = a[id];
    const y = b[id];
    return y && x.name === y.name && x.description === y.description && x.status === y.status;
  });
}
