// Cache countdown: how long each subagent's and teammate's prompt cache has
// left, drawn in the band above the prompt. The main loop is not tracked.
//
// Tracking lives in `$.state`, not module variables: a reload (a `/config`
// change of this plugin's options, or the engine replacing its worker) runs
// `register` again, and module variables would forget every idle agent until
// it next woke, which is exactly the agent the countdown is for.

import { atom, read, update } from 'claude-code';
import {
  anyLive,
  clearInFlight,
  contextTokens,
  endRequest,
  mainViewSegments,
  rosterFrom,
  sameRoster,
  shiftInFlight,
  startRequest,
  ttlSeconds,
  viewedAgentSegments,
} from './lib/countdown.mjs';

const agents = atom({ plugin: 'cache', key: 'agents' }, {});
const roster = atom({ plugin: 'cache', key: 'roster' }, {});

const ROSTER_EVERY_TICKS = 5;
// The setting is read again this often, so a change is picked up and a failed read is retried.
const TTL_READ_EVERY_MS = 30_000;
// Roster lookups for ids it does not list (engine forks) run at most this often.
const ROSTER_LOOKUP_GAP_MS = 2000;
const UNLISTED_CAP = 500;

// Read at `session.start` and every `TTL_READ_EVERY_MS` after; `session.start` clears them.
let ttlMs;
let ttlReadAt;
let ttlReading;
let ticker;
// Whether the last band render drew a row; an expired track alone does not keep the tick redrawing.
let lastDrew = false;
// A reload forgets these, which costs one lookup at most.
let lastRosterAt;
const unlisted = new Set();

function quiet($, where, err) {
  try {
    $.ui.log(`cache: ${where}: ${err && err.message ? err.message : String(err)}`, { to: 'debug' });
  } catch {
    // Nowhere left to report; the countdown stays quiet.
  }
}

async function readTtl($, options) {
  try {
    const setting = await $.settings.read({ key: 'subagentPromptCacheTtl' });
    ttlMs = ttlSeconds(setting, options.ttl_seconds) * 1000;
  } catch (err) {
    // The default is not kept: the next read in 30 s may succeed. A value read earlier stands.
    quiet($, 'settings.read', err);
  }
}

async function cacheTtlMs($, options, now) {
  if (ttlReadAt === undefined || now < ttlReadAt || now - ttlReadAt >= TTL_READ_EVERY_MS) {
    ttlReadAt = now;
    ttlReading = readTtl($, options).finally(() => {
      ttlReading = undefined;
    });
  }
  if (ttlReading) await ttlReading;
  return ttlMs ?? ttlSeconds(undefined, options.ttl_seconds) * 1000;
}

// `askedId`: the agent whose lookup this is; one the roster does not list is remembered.
async function refreshRoster($, askedId) {
  const next = rosterFrom(await $.agent.list());
  if (askedId && !next[askedId]) {
    if (unlisted.size >= UNLISTED_CAP) unlisted.clear();
    unlisted.add(askedId);
  }
  if (!sameRoster(await read($, roster), next)) await update($, roster, () => next);
}

// For a turn.step whose agent the roster lacks; engine forks are never listed, so each id is asked once.
async function lookUpAgent($, id) {
  if ((await read($, roster))[id] || unlisted.has(id)) return;
  const now = await $.clock.now();
  if (lastRosterAt !== undefined && now >= lastRosterAt && now - lastRosterAt < ROSTER_LOOKUP_GAP_MS) return;
  lastRosterAt = now;
  await refreshRoster($, id);
}

// One tick: with no agent tracked there is nothing to redraw or look up.
async function onTick($, tick, options) {
  const tracked = await read($, agents);
  if (Object.keys(tracked).length === 0) return;
  if (!lastDrew) {
    const now = await $.clock.now();
    const ttl = await cacheTtlMs($, options, now);
    if (!anyLive(tracked, await read($, roster), now, ttl)) return;
  }
  $.ui.invalidate('ui.render');
  if (tick % ROSTER_EVERY_TICKS === 0) {
    lastRosterAt = await $.clock.now();
    await refreshRoster($);
  }
}

const TONE_PROPS = {
  dim: { dimColor: true },
  warn: { color: 'warning' },
  expired: { color: 'error' },
};

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    try {
      ttlMs = undefined;
      ttlReadAt = undefined;
      lastRosterAt = undefined;
      unlisted.clear();
      await update($, agents, clearInFlight);
      if (ticker) ticker.cancel();
      let tick = 0;
      ticker = $.clock.every(1000, () => {
        tick += 1;
        onTick($, tick, options).catch(err => quiet($, 'tick', err));
      });
    } catch (err) {
      quiet($, 'session.start', err);
    }
    return result;
  });

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId;
    if (!id) return yield* next(e);
    let isCounted = false;
    try {
      // Before the request: the cache's five minutes run from when it was sent.
      const now = await $.clock.now();
      await update($, agents, all => startRequest(all, id, now));
      isCounted = true;
    } catch (err) {
      quiet($, 'turn.step', err);
    }
    let result;
    try {
      result = yield* next(e);
    } finally {
      if (isCounted) {
        try {
          const tokens = contextTokens(result && result.usage);
          await update($, agents, all => endRequest(all, id, tokens));
        } catch (err) {
          quiet($, 'turn.step', err);
        }
      }
    }
    // Not awaited: the stream's result goes back without waiting on the roster.
    lookUpAgent($, id).catch(err => quiet($, 'agent.list', err));
    return result;
  });

  on('tool.call', async ($, e, next) => {
    const id = e.agentId;
    if (!id) return next(e);
    let isCounted = false;
    try {
      const now = await $.clock.now();
      await update($, agents, all => shiftInFlight(all, id, 1, now));
      isCounted = true;
    } catch (err) {
      quiet($, 'tool.call', err);
    }
    try {
      return await next(e);
    } finally {
      if (isCounted) {
        try {
          await update($, agents, all => shiftInFlight(all, id, -1));
        } catch (err) {
          quiet($, 'tool.call', err);
        }
      }
    }
  }).catch(($, e, next) => next(e));

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let row;
    let Box;
    try {
      const viewed = e.props.view && e.props.view.agentId;
      if (!e.props.hasSurvey && (viewed || options.main_view !== false)) {
        const now = await $.clock.now();
        const ttl = await cacheTtlMs($, options, now);
        const tracked = await read($, agents);
        const listed = await read($, roster);
        const segments = viewed
          ? viewedAgentSegments(tracked[viewed], now, ttl, listed[viewed]?.status)
          : mainViewSegments(tracked, listed, now, ttl);
        if (segments) {
          const elements = $.ui.resolve(e);
          Box = elements.Box;
          row = Box({
            key: 'cache',
            flexDirection: 'row',
            paddingX: 1,
            children: segments.map(s => elements.Text({ ...TONE_PROPS[s.tone], wrap: 'truncate-end', children: s.text })),
          });
        }
      }
    } catch (err) {
      quiet($, 'ui.render', err);
      row = undefined;
    }
    lastDrew = Boolean(row);
    if (!row) return next(e);
    // Later mods keep their band output under ours.
    const below = await next(e);
    return below ? Box({ flexDirection: 'column', children: [row, below] }) : row;
  }).catch(($, e, next) => next(e));
};
