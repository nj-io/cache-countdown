// The `$.state` values the cache countdown keeps for the session.

/** One agent: when its latest model request started, its context size, calls in flight and since when. */
export type CacheAgentTrack = { lastRequestAt: number; contextTokens: number; inFlight: number; workingSince?: number };

/** One `$.agent.list()` row, as the countdown keeps it. */
export type CacheRosterEntry = { name?: string; description?: string; status: string };

declare module 'claude-code' {
  interface PluginState {
    cache: {
      agents: Record<string, CacheAgentTrack>;
      roster: Record<string, CacheRosterEntry>;
    };
  }
}
