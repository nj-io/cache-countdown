// Cache countdown: how long each subagent's and teammate's prompt cache has
// left, drawn in the band above the prompt, and the main session's own.
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
  isPersonPrompt,
  KEEP_ALIVE_INITIAL,
  KEEP_ALIVE_TEXT,
  keepAliveConfig,
  keepAliveDue,
  MAIN_KEY,
  mainRequestStarted,
  mainTtlSeconds,
  mainViewSegments,
  personPrompted,
  pingFailed,
  pingSent,
  rosterFrom,
  sameRoster,
  shiftInFlight,
  startRequest,
  ttlSeconds,
  viewedAgentSegments,
} from './lib/countdown.mjs';

const agents = atom({ plugin: 'cache', key: 'agents' }, {});
const roster = atom({ plugin: 'cache', key: 'roster' }, {});
// Pings sent since a person's last prompt, and whether the latest has yet to start its turn.
const keepAlive = atom({ plugin: 'cache', key: 'keepAlive' }, KEEP_ALIVE_INITIAL);

const ROSTER_EVERY_TICKS = 5;
// The setting is read again this often, so a change is picked up and a failed read is retried.
const TTL_READ_EVERY_MS = 30_000;
// Roster lookups for ids it does not list (engine forks) run at most this often.
const ROSTER_LOOKUP_GAP_MS = 2000;
const UNLISTED_CAP = 500;
// With nothing live, the main row's only change is its expired age, in whole minutes or more.
const IDLE_REDRAW_EVERY_TICKS = 60;

// Read at `session.start` and every `TTL_READ_EVERY_MS` after; `session.start` clears them.
let ttlMs;
let ttlReadAt;
let ttlReading;
let ticker;
// Whether the last band render drew a row; an expired track alone does not keep the tick redrawing.
let lastDrew = false;
// Whether that row was the main view's, which redraws only once a minute while nothing is live.
let lastDrewMainView = false;
// Whether the last tick that checked found something live; the tick that finds nothing redraws once more.
let wasLive = false;
// Set while a tick decides on a ping, so two ticks never send one each.
let isPinging = false;
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

// Pings the main session when its cache is about to lapse. Never rejects: a failure is logged and the countdown goes on.
async function keepMainAlive($, options, tracked) {
  const mainTtlMs = mainTtlSeconds(options.main_ttl_seconds) * 1000;
  const config = keepAliveConfig(options, mainTtlMs);
  if (!config.isOn || isPinging || !tracked[MAIN_KEY]) return;
  isPinging = true;
  try {
    const first = keepAliveDue(tracked, await read($, keepAlive), config, await $.clock.now(), mainTtlMs);
    if (!first) return;
    // A draft in the box is a person at work; a read that fails is no reason to risk typing over one.
    const draft = await $.prompt.read();
    if (typeof draft?.text !== 'string' || draft.text !== '') return;
    // The turn may have started while the draft was read.
    if (!keepAliveDue(await read($, agents), await read($, keepAlive), config, await $.clock.now(), mainTtlMs)) return;
    await update($, keepAlive, pingSent);
    try {
      const sent = await $.prompt.submit({ text: KEEP_ALIVE_TEXT });
      if (sent && sent.drop) throw new Error(`dropped: ${sent.drop}`);
    } catch (err) {
      quiet($, 'prompt.submit', err);
      await update($, keepAlive, pingFailed);
    }
  } catch (err) {
    quiet($, 'keep-alive', err);
  } finally {
    isPinging = false;
  }
}

// One tick: with no agent tracked there is nothing to redraw or look up.
async function onTick($, tick, options) {
  const tracked = await read($, agents);
  if (Object.keys(tracked).length === 0) return;
  // Not awaited: the redraw below does not wait on the ping.
  keepMainAlive($, options, tracked);
  if (!lastDrew || lastDrewMainView) {
    const now = await $.clock.now();
    const ttl = await cacheTtlMs($, options, now);
    const isLive = anyLive(tracked, await read($, roster), now, ttl, mainTtlSeconds(options.main_ttl_seconds) * 1000);
    const redraw = isLive || wasLive || (lastDrew && tick % IDLE_REDRAW_EVERY_TICKS === 0);
    wasLive = isLive;
    if (!redraw) return;
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
      wasLive = false;
      isPinging = false;
      unlisted.clear();
      await update($, keepAlive, () => KEEP_ALIVE_INITIAL);
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
    // A request with no agent id is the main loop's, kept under its own key.
    const isMain = !e.agentId;
    const id = e.agentId || MAIN_KEY;
    let isCounted = false;
    try {
      // Before the request: the cache's five minutes run from when it was sent.
      const now = await $.clock.now();
      await update($, agents, all => startRequest(all, id, now));
      isCounted = true;
      // The ping, if one was pending, has started its turn.
      if (isMain && (await read($, keepAlive)).pending) await update($, keepAlive, mainRequestStarted);
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
    // The roster does not list the main session.
    if (isMain) return result;
    // Not awaited: the stream's result goes back without waiting on the roster.
    lookUpAgent($, id).catch(err => quiet($, 'agent.list', err));
    return result;
  });

  // Observes only. A prompt the person sent starts the run of pings over; notifications, triggers, peers and other plugins do not.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (isPersonPrompt(e.origin) && (await read($, keepAlive)).pings > 0) await update($, keepAlive, personPrompted);
    } catch (err) {
      quiet($, 'prompt.submit', err);
    }
    return next(e);
  }).catch(($, e, next) => next(e));

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
    let isMainView = false;
    try {
      const viewed = e.props.view && e.props.view.agentId;
      if (!e.props.hasSurvey && (viewed || options.main_view !== false)) {
        const now = await $.clock.now();
        const ttl = await cacheTtlMs($, options, now);
        const tracked = await read($, agents);
        const listed = await read($, roster);
        const pings = (await read($, keepAlive)).pings;
        const config = keepAliveConfig(options, mainTtlSeconds(options.main_ttl_seconds) * 1000);
        const kept = config.isOn && pings > 0 ? { count: pings, max: config.max } : undefined;
        const segments = viewed
          ? viewedAgentSegments(tracked[viewed], now, ttl, listed[viewed]?.status)
          : mainViewSegments(tracked, listed, now, ttl, undefined, mainTtlSeconds(options.main_ttl_seconds) * 1000, kept);
        if (segments) {
          isMainView = !viewed;
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
    lastDrewMainView = lastDrew && isMainView;
    if (!row) return next(e);
    // Later mods keep their band output under ours.
    const below = await next(e);
    return below ? Box({ flexDirection: 'column', children: [row, below] }) : row;
  }).catch(($, e, next) => next(e));
};
