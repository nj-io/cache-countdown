# cache

A Claude Code plugin that shows how long each subagent's prompt cache has left, and stops Claude from waking a large agent whose cache has expired without first weighing a fresh start.

A subagent or teammate keeps its prompt cache for five minutes after its last request. Waking it later (a `SendMessage` to a finished agent) writes its whole conversation to the cache again at the cache-write price, which is much higher than the price of reading a warm cache. Every later turn then re-reads all of it. For an agent holding 150K tokens, a one-line follow-up after a coffee break costs as much as the original work, and a fresh agent given a short handoff often costs less.

The plugin has two parts:

- **Countdown** (a mod): shows the time left on each agent's cache.
- **Guard** (a `PreToolUse` hook on `SendMessage`): blocks one message to an idle agent whose cache has expired and that holds at least 50K tokens, and tells Claude what the choice costs.

## What you see

The countdown is a row above the prompt.

In the main view it lists the agents whose cache is still alive, soonest expiry first, at most three, then a count of the rest:

```
 cache  reviewer-auth 0:48 · builder-auth 3:12 · +2 more
```

In an agent's own view (open it from the footer agent list) it shows that agent's state and context size:

```
 cache 2:41 left · 47K
 cache expired 28 s ago · waking re-stores 47K
 cache working · 1:12 left · 47K
```

Alive countdowns are dim, switch to the theme's warning color at a minute or less, and the expired row uses the error color. An agent that is inside a model request or a tool call shows as `working` in its own view (with the time left when the cache is still alive) and is left out of the main row. A label is the agent's name, else the first 16 characters of its description, else the start of its id; agents that share a label get `#` and four characters of their id (`builder#3f9a`). Times left show as `m:ss`, or `h:mm:ss` from an hour; the time since expiry shows as seconds, minutes, or, from an hour, hours and minutes (`2 h 10 min ago`). The guard's deny text reads in minutes up to 120 min, then hours up to 48 h, then days. A `working` agent whose cache has already expired shows `cache working · expired 2 min ago · 47K`. The main row can be turned off (see Options); each agent's own view always shows its countdown.

## What the guard does

When Claude calls `SendMessage` to an agent that has been idle longer than the cache lifetime and holds at least `min_tokens` tokens, the call is denied and Claude receives this as the tool result:

```
scribe has been idle 6 min and its cache has expired. Waking it re-stores its 47K-token conversation once, and every later turn re-reads all 47K.

Decide which is cheaper:
- **Resume** (re-send with [cold-resume-ok]) if the next task needs most of what this agent already read.
- **Start fresh** if it needs only part of it. Rule of thumb: start fresh unless the task needs more than half of the old agent's context.

If you start fresh, hand it this:
- scribe's closing summary (in its final message to you)
- Report: <path>            (only when the agent wrote a *report*.md)
- Edited: <files>
- Read: <files>
- Commits: <shas>           (only when found)
- Last tests: <command>, <result>   (only when found; the result reads "result not shown" when the output has no summary line)
```

`Edited` and `Read` list `none` when empty. The handoff is built from the agent's transcript: files it edited and read (at most 10 each), the newest report file, up to 3 commits, and the last test command with its summary line.

The block is one-shot: after a block, the next message to the same agent from the same session within 15 minutes goes through, so an agent that retries cannot loop. The guard keeps these records in `<config dir>/logs/cache/recent-denies.json` and drops those older than an hour. To override at any time, send the message with `[cold-resume-ok]` anywhere in its text. You can also tell Claude to resume the agent and it will add the marker.

The guard lets a message through when:

- the target is `main`, `team-lead`, or an address containing `@`, `:` or a space (a peer address such as `name@session` or `uds:…`), or it matches no subagent of this session (matching is exact on the agent's name or id);
- the message is a protocol message rather than text (shutdown and plan-approval replies);
- the sender is an engine-internal fork (its hook input carries an `agent_id` with no meta file in the session's subagents directory);
- the agent is busy: it has an open tool call (of any age), or it is answering a tool result or delivered message at most 10 minutes old;
- the agent's cache is still alive, it has no recorded usage, or it holds fewer than `min_tokens` tokens;
- the message went through the one-shot rule above or carries `[cold-resume-ok]`;
- anything unexpected happens (an unreadable transcript, missing fields, no `python3`). The guard never blocks on an error.

## Install

In Claude Code:

```
/plugin marketplace add nj-io/cache-countdown
/plugin install cache@cache-countdown
```

To try a local checkout:

```
/plugin marketplace add /path/to/cache-countdown
/plugin install cache@cache-countdown
```

or load it for one session without installing: `claude --plugin-dir /path/to/cache-countdown` (the plugin id is then `cache@inline`).

From a shell: `claude plugin marketplace add nj-io/cache-countdown` and `claude plugin install cache@cache-countdown`. Add `--scope project` to either to declare it in the current project's settings instead of your user settings. The installer prints "4 userConfig options not yet set"; all four are optional and have working defaults.

## Options

| Key | Default | Meaning |
|---|---|---|
| `ttl_seconds` | unset | Cache lifetime in seconds. Empty: the guard uses `subagentPromptCacheTtl` from user, project, local and managed settings (`1h` gives 3600 s, anything else 300 s). A lifetime set with `--settings` is not visible to the guard, so set `ttl_seconds` explicitly in that case. |
| `min_tokens` | 50000 | The guard stops a message only to an agent holding at least this many tokens. May be 0, which guards every agent with recorded usage. An invalid value falls back to the default. |
| `log_events` | false | Appends one JSON line per guard decision to `<config dir>/logs/cache/guard.jsonl` (`~/.claude/logs/cache/guard.jsonl` by default). Fields: `ts`, `session`, `target`, `decision` (`pass`, `deny` or `override`), `reason`, `idle_s`, `tokens`. |
| `main_view` | true | Shows the countdown row in the main view. |

The one-shot state is kept in `<config dir>/logs/cache/recent-denies.json` (written after every block, whether or not `log_events` is on); delete it to reset.

Set them in Claude Code with `/plugin configure cache@cache-countdown`, from a shell with `claude plugin configure cache@cache-countdown`, or in your user settings:

```json
{
  "pluginConfigs": {
    "cache@cache-countdown": {
      "options": { "ttl_seconds": 600, "min_tokens": 20000, "log_events": true }
    }
  }
}
```

`pluginConfigs` is read from user settings, `--settings` and managed settings. Project settings are not read for it.

## Requirements

- Claude Code 2.1.290 or later (tested on 2.1.304), with mods on (the default). The countdown is a mod.
- `python3` on `PATH`, for the guard. Without it the guard hook fails with a non-blocking error and every message goes through; the countdown still works.
  - On Windows, `python3` is often the Microsoft Store stub, which prints a message and exits on every `SendMessage`. The guard then does nothing.
  - On a Mac without the Command Line Tools, `/usr/bin/python3` opens the install dialog on every `SendMessage`. Install Python, or turn the plugin off with `/plugin`.

## Turn it off

- `/plugin disable cache@cache-countdown` (or `claude plugin disable cache@cache-countdown`) turns off both parts. `claude plugin uninstall cache@cache-countdown` removes it.
- `main_view: false` hides the main row only.
- A single message passes with `[cold-resume-ok]`.

## Known limits

- **The guard measures idle time from the end of the agent's last response**, so it can think an agent has been idle up to one response's generation time less than it has. It may let a message through shortly after the cache expired, and never blocks earlier than the cache's own lifetime.
- **The guard reads the last 4 MiB of a transcript.** A very long transcript's handoff lists only what falls in that window.
- **An agent that is waiting on its own long command is shown but not guarded.** While an agent has an open tool call, the guard passes messages to it, however long the call has run. The countdown stops showing such an agent as `working` after 10 minutes. While it shows `working`, it appears in the agent's own view and not in the main row.
- **Only in-process teammates and subagents are guarded and counted.** Teammates in tmux or iTerm pane mode run as separate sessions and pass. Addresses containing `@`, `:` or a space pass as peer addresses.
- **Only `SendMessage` is guarded.** Other ways of resuming an agent are not.
- **It cannot change your cache settings.** `CLAUDE_CODE_SUBAGENT_MODEL` (which model subagents use) and `subagentPromptCacheTtl` (a one-hour cache lifetime) are yours to set; the plugin reads the latter and adjusts its thresholds.
- The countdown tracks subagents and teammates, not the main session.

## Tests

From the repository root:

```
python3 -m pytest -q tests/        # guard: needs pytest
claude plugin test .               # countdown: kit tests with a mock clock
claude plugin validate . --strict  # manifest, hooks and mod checks
```

## License

MIT. See `LICENSE`.
