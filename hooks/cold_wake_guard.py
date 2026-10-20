#!/usr/bin/env python3
"""PreToolUse hook for SendMessage: before Claude wakes a subagent or teammate whose
prompt cache has expired, stop the message and tell Claude the choice it faces.

Subagents keep their prompt cache for five minutes after their last request. Waking
one later stores its whole conversation again at the full write price. The hook does
not decide: it blocks the first send with the facts and a ready-made handoff; the
sender either starts a fresh agent or re-sends with [cold-resume-ok]. A plain
re-send to the same target within 15 minutes of the block passes too.

Python 3 standard library only. Every unexpected condition passes (fail open)."""
import fnmatch
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

MARKER = "[cold-resume-ok]"
PROTOCOL_TARGETS = ("main", "team-lead")
TAIL_BYTES = 4 * 1024 * 1024
DEFAULT_TTL_SECONDS = 300
LONG_TTL_SECONDS = 3600
DEFAULT_MIN_TOKENS = 50_000
MAX_EDITED = 10
MAX_READ = 10
MAX_COMMITS = 3
SHA_LENGTH = 8
BUSY_MAX_SECONDS = 600  # how long a trailing user entry (tool result, delivered message) can wait for the model
REMINDED_SECONDS = 900  # a send within this long of a deny to the same target passes
DENIES_KEEP_SECONDS = 3600
ENV_PREFIX = "CLAUDE_PLUGIN_OPTION_"

_COMMIT_CMD = re.compile(r"\bgit(\s+-[cC]\s+\S+)*\s+commit\b")
_COMMIT_BRACKET = re.compile(r"^\[[^\]\n]*\s([0-9a-f]{7,40})\]", re.M)
_COMMIT_ONELINE = re.compile(r"^([0-9a-f]{7,40}) \S", re.M)
_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")
_ENV_ASSIGN = re.compile(r"""^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+""")
_TEST_CMD = re.compile(
    r"^(?:(?:(?:\S*python[\d.]*|\$\{?\w+\}?)\s+-m\s+)?pytest\b|(?:\S*/)?pytest\b"
    r"|npx\s+vitest\b|npm\s+(?:run\s+)?test\b|go\s+test\b|cargo\s+test\b)"
)
_PYTEST_SUMMARY = re.compile(
    r"([^=\n]*?\b\d+ (?:passed|failed|errors?)\b[^=\n]*?) in [\d.]+s\b"
)
_PYTEST_COUNT = re.compile(r"(\d+) (passed|failed|errors?)\b")
_VITEST_SUMMARY = re.compile(r"^\s*Tests\s+(.*\(\d+\))", re.M)
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


# --- configuration ---------------------------------------------------------


def _parse_int(value, minimum=1):
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if n >= minimum else None


def _parse_bool(value):
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def claude_dir(env):
    """The Claude config directory: CLAUDE_CONFIG_DIR when set, else ~/.claude."""
    configured = env.get("CLAUDE_CONFIG_DIR")
    if configured:
        return configured
    return os.path.join(env.get("HOME") or os.path.expanduser("~"), ".claude")


def managed_settings_paths(env=None):
    """Where the organisation's managed settings file lives on this platform."""
    if sys.platform == "darwin":
        return ["/Library/Application Support/ClaudeCode/managed-settings.json"]
    if sys.platform == "win32":
        base = (env or os.environ).get("PROGRAMDATA") or r"C:\ProgramData"
        return [os.path.join(base, "ClaudeCode", "managed-settings.json")]
    return ["/etc/claude-code/managed-settings.json"]


def read_cache_ttl_setting(env, cwd=None, managed_paths=None):
    """The `subagentPromptCacheTtl` setting, or None. Sources, later winning:
    user settings.json, then `<cwd>/.claude/settings.json` and settings.local.json,
    then the managed settings file, which overrides all of them."""
    paths = [os.path.join(claude_dir(env), "settings.json")]
    if isinstance(cwd, str) and cwd:
        paths += [os.path.join(cwd, ".claude", name) for name in ("settings.json", "settings.local.json")]
    paths += managed_settings_paths(env) if managed_paths is None else managed_paths
    found = None
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                value = json.load(fh).get("subagentPromptCacheTtl")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(value, str):
            found = value
    return found


def resolve_config(env, cwd=None, managed_paths=None):
    """Thresholds and the log switch. Plugin userConfig arrives as
    CLAUDE_PLUGIN_OPTION_<KEY>; an unset or invalid option takes its default
    (min_tokens may be 0, ttl_seconds may not).
    The 1h cache setting (user, project, local or managed settings, `cwd` being the
    hook's working directory) raises the ttl unless ttl_seconds is set explicitly."""
    ttl = _parse_int(env.get(ENV_PREFIX + "TTL_SECONDS"))
    if ttl is None:
        one_hour = read_cache_ttl_setting(env, cwd, managed_paths) == "1h"
        ttl = LONG_TTL_SECONDS if one_hour else DEFAULT_TTL_SECONDS
    min_tokens = _parse_int(env.get(ENV_PREFIX + "MIN_TOKENS"), minimum=0)
    cache_dir = os.path.join(claude_dir(env), "logs", "cache")
    return {
        "ttl_seconds": ttl,
        "min_tokens": DEFAULT_MIN_TOKENS if min_tokens is None else min_tokens,
        "log_events": _parse_bool(env.get(ENV_PREFIX + "LOG_EVENTS")),
        "log_path": os.path.join(cache_dir, "guard.jsonl"),
        "denies_path": os.path.join(cache_dir, "recent-denies.json"),
    }


# --- the hook input --------------------------------------------------------


def message_target(tool_input):
    """The `to` value (older calls used `recipient`), or "" when absent."""
    for key in ("to", "recipient"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def is_peer_address(to):
    """Targets that are not this session's subagents: the main session, the team
    lead, peer sessions (`name@session`, `uds:` sockets) and anything with a space."""
    return (not to) or to in PROTOCOL_TARGETS or any(c in to for c in " @:")


def session_id(data):
    """The hook input's session id, falling back to the transcript file's own stem."""
    session = data.get("session_id")
    if isinstance(session, str) and session:
        return session
    return os.path.splitext(os.path.basename(data["transcript_path"]))[0]


def subagents_dir(data):
    """`<transcript dir>/<session id>/subagents`."""
    transcript = data.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return None
    return os.path.join(os.path.dirname(transcript), session_id(data), "subagents")


def is_engine_fork(data, sub_dir):
    """True when the sender is an engine-internal fork: the hook input carries an
    `agent_id` that has no meta file in the session's subagents directory. Senders
    with a real meta file (subagents, teammates) stay guarded."""
    agent_id = data.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        return False
    return not os.path.exists(os.path.join(sub_dir, "agent-%s.meta.json" % agent_id))


# --- the target ------------------------------------------------------------


def find_target(sub_dir, to):
    """The subagent `to` names, matched exactly on `meta.name` or on the agent id
    (the filename minus `agent-` and `.meta.json`). Several matches: the one spawned
    last wins, by the meta file's mtime (a later send touches only the transcript).
    No match, or an unreadable directory: None. Never a prefix."""
    try:
        names = sorted(os.listdir(sub_dir))
    except OSError:
        return None
    best = None
    for filename in names:
        if not (filename.startswith("agent-") and filename.endswith(".meta.json")):
            continue
        agent_id = filename[len("agent-") : -len(".meta.json")]
        transcript = os.path.join(sub_dir, "agent-%s.jsonl" % agent_id)
        meta_path = os.path.join(sub_dir, filename)
        try:
            with open(meta_path, encoding="utf-8") as fh:
                meta = json.load(fh)
            os.stat(transcript)
            mtime = os.path.getmtime(meta_path)
        except (OSError, ValueError):
            continue
        name = meta.get("name") if isinstance(meta, dict) else None
        if to != agent_id and to != name:
            continue
        if best is None or mtime > best["mtime"]:
            best = {
                "name": name if isinstance(name, str) and name else to,
                "id": agent_id,
                "path": transcript,
                "mtime": mtime,
            }
    return best


# --- the transcript --------------------------------------------------------


def read_tail(path, max_bytes=TAIL_BYTES):
    """The parsed entries of the last `max_bytes` of a JSONL transcript. When the
    read starts mid-file, the first partial line is dropped. Unparseable lines
    and non-object lines are skipped."""
    with open(path, "rb") as fh:
        size = fh.seek(0, os.SEEK_END)
        if size <= max_bytes:
            fh.seek(0)
            data = fh.read()
        else:
            fh.seek(size - max_bytes - 1)
            data = fh.read()
            # The extra byte tells whether the window starts on a line boundary.
            starts_on_line = data[:1] == b"\n"
            data = data[1:]
            if not starts_on_line:
                cut = data.find(b"\n")
                data = data[cut + 1 :] if cut >= 0 else b""
    entries = []
    for line in data.split(b"\n"):
        try:
            entry = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


def _blocks(entry):
    content = (entry.get("message") or {}).get("content")
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []


def _message_entries(entries):
    return [e for e in entries if e.get("type") in ("assistant", "user") and e.get("message")]


def is_busy(entries, now=None):
    """True when the agent is mid-turn, so its cache is in use rather than expired.
    Busy when the last message entry is an assistant `tool_use` with no result yet,
    of any age (a nested Agent call or a permission prompt has no upper bound), or
    a `user` entry (a tool result or delivered message the model is answering) at
    most BUSY_MAX_SECONDS old. The last message always follows the last usage entry.
    A user entry with no readable timestamp counts as busy."""
    messages = _message_entries(entries)
    if not messages:
        return False
    last = messages[-1]
    if last.get("type") == "assistant":
        return any(b.get("type") == "tool_use" for b in _blocks(last))
    stamp = parse_timestamp(last.get("timestamp"))
    return now is None or stamp is None or now - stamp <= BUSY_MAX_SECONDS


def parse_timestamp(value):
    """Epoch seconds of an ISO-8601 timestamp (`Z` suffix allowed), or None."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def last_usage(entries):
    """(epoch seconds, context tokens) of the last entry that carries usage and a
    timestamp, or None. Context is input + cache read + cache creation tokens.
    Synthetic entries (`<synthetic>` model, as written after a session-limit error)
    and entries whose usage sums to zero are not requests and are skipped."""
    found = None
    for entry in entries:
        message = entry.get("message") or {}
        usage = message.get("usage")
        stamp = parse_timestamp(entry.get("timestamp"))
        if not isinstance(usage, dict) or stamp is None or message.get("model") == "<synthetic>":
            continue
        tokens = sum(
            usage.get(k) or 0
            for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
        )
        if tokens == 0:
            continue
        found = (stamp, tokens)
    return found


# --- the handoff -----------------------------------------------------------


def _tool_uses(entries, name):
    """(tool_use id, input) pairs for tool `name`, oldest first."""
    return [
        (b.get("id"), b.get("input") or {})
        for e in entries
        if e.get("type") == "assistant"
        for b in _blocks(e)
        if b.get("type") == "tool_use" and b.get("name") == name
    ]


def _result_texts(entries):
    """tool_use id -> the text of its tool_result."""
    texts = {}
    for entry in entries:
        for block in _blocks(entry):
            if block.get("type") != "tool_result":
                continue
            content = block.get("content")
            if isinstance(content, list):
                content = "\n".join(
                    b.get("text", "") for b in content if isinstance(b, dict)
                )
            texts[block.get("tool_use_id")] = content if isinstance(content, str) else ""
    return texts


def _newest_first_unique(paths, limit=None):
    seen, out = set(), []
    for path in reversed(paths):
        if path not in seen:
            seen.add(path)
            out.append(path)
    return out[:limit] if limit else out


def _ordered_file_paths(entries, tool_names):
    """Paths touched by `tool_names`, in transcript order."""
    wanted = set(tool_names)
    paths = []
    for entry in entries:
        if entry.get("type") != "assistant":
            continue
        for block in _blocks(entry):
            inp = block.get("input") or {}
            if (
                block.get("type") == "tool_use"
                and block.get("name") in wanted
                and isinstance(inp.get("file_path"), str)
            ):
                paths.append(inp["file_path"])
    return paths


def find_edited(entries):
    """`file_path` of Edit, Write and NotebookEdit calls: newest first, unique, at most 10."""
    paths = _ordered_file_paths(entries, ("Edit", "Write", "NotebookEdit"))
    return _newest_first_unique(paths, MAX_EDITED)


def find_read(entries):
    """`Read` paths that were not edited and are not images: newest first, unique,
    at most 10."""
    edited = set(_ordered_file_paths(entries, ("Edit", "Write", "NotebookEdit")))
    paths = [
        p
        for p in _ordered_file_paths(entries, ("Read",))
        if p not in edited and not p.lower().endswith(_IMAGE_EXT)
    ]
    return _newest_first_unique(paths, MAX_READ)


def find_report(entries):
    """The newest `Write` whose path matches `*report*.md`, or None."""
    paths = [
        p
        for p in _ordered_file_paths(entries, ("Write",))
        if fnmatch.fnmatchcase(os.path.basename(p), "*report*.md")
    ]
    return paths[-1] if paths else None


def find_commits(entries):
    """Shas (shortened to 8 characters) of commits the agent made, newest first, at
    most 3. After a Bash
    command that runs `git commit`, the bracket form `[branch sha]` in its output;
    failing that, the first output line shaped like `sha subject`."""
    texts = _result_texts(entries)
    shas = []
    for use_id, inp in _tool_uses(entries, "Bash"):
        if not _COMMIT_CMD.search(str(inp.get("command") or "")):
            continue
        output = texts.get(use_id, "")
        match = _COMMIT_BRACKET.search(output) or _COMMIT_ONELINE.search(output)
        if match:
            shas.append(match.group(1)[:SHA_LENGTH])
    return _newest_first_unique(shas, MAX_COMMITS)


def find_test_command(command):
    """The test command inside a Bash command line, without leading `cd …`, env
    assignments or trailing redirections and pipes, or None."""
    for segment in re.split(r"&&|\|\||;|\n", command):
        segment = segment.strip()
        segment = _ENV_ASSIGN.sub("", segment + " ").strip()
        if _TEST_CMD.match(segment):
            return re.split(r"\s+(?:2>&1|\||>|<)", segment)[0].strip()
    return None


def parse_test_result(output):
    """The result of a test run from its summary line, or None: pytest's counts
    of passed, failed and error; vitest's `Tests` line."""
    output = _ANSI.sub("", output or "")
    pytest_lines = _PYTEST_SUMMARY.findall(output)
    if pytest_lines:
        counts = _PYTEST_COUNT.findall(pytest_lines[-1])
        return ", ".join("%s %s" % pair for pair in counts)
    vitest_lines = _VITEST_SUMMARY.findall(output)
    if vitest_lines:
        return vitest_lines[-1].strip()
    return None


def find_last_tests(entries):
    """(command, result) of the last Bash call that ran tests, or None. The result
    is "result not shown" when its output has no recognised summary line."""
    texts = _result_texts(entries)
    for use_id, inp in reversed(_tool_uses(entries, "Bash")):
        command = find_test_command(str(inp.get("command") or ""))
        if command:
            return command, parse_test_result(texts.get(use_id)) or "result not shown"
    return None


def extract_handoff(entries):
    return {
        "report": find_report(entries),
        "edited": find_edited(entries),
        "read": find_read(entries),
        "commits": find_commits(entries),
        "last_tests": find_last_tests(entries),
    }


# --- the message -----------------------------------------------------------

_MESSAGE_HEAD = """\
{name} has been idle {idle} and its cache has expired. Waking it re-stores its {k}K-token conversation once, and every later turn re-reads all {k}K.

Decide which is cheaper:
- **Resume** (re-send with [cold-resume-ok]) if the next task needs most of what this agent already read.
- **Start fresh** if it needs only part of it. Rule of thumb: start fresh unless the task needs more than half of the old agent's context.

If you start fresh, hand it this:
- {name}'s closing summary (in its final message to you)"""


def format_idle(idle_seconds):
    """`20 min` up to 120 minutes, `6 h` up to 48 hours, then `15 days`; each floored."""
    minutes = int(idle_seconds // 60)
    if minutes <= 120:
        return "%d min" % minutes
    if minutes <= 48 * 60:
        return "%d h" % (minutes // 60)
    return "%d days" % (minutes // (24 * 60))


def render_message(name, idle_seconds, tokens, handoff):
    """The deny reason. Report, Commits and Last tests lines appear only when found."""
    lines = [
        _MESSAGE_HEAD.format(name=name, idle=format_idle(idle_seconds), k=tokens // 1000)
    ]
    if handoff.get("report"):
        lines.append("- Report: %s" % handoff["report"])
    lines.append("- Edited: %s" % (", ".join(handoff.get("edited") or []) or "none"))
    lines.append("- Read: %s" % (", ".join(handoff.get("read") or []) or "none"))
    if handoff.get("commits"):
        lines.append("- Commits: %s" % ", ".join(handoff["commits"]))
    if handoff.get("last_tests"):
        lines.append("- Last tests: %s, %s" % handoff["last_tests"])
    return "\n".join(lines)


# --- one-shot deny ---------------------------------------------------------


def _read_denies(path):
    try:
        with open(path, encoding="utf-8") as fh:
            rows = json.load(fh)
    except (OSError, ValueError):
        return []
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def recently_denied(path, session, target_id, now):
    """True when a deny for this session and target was recorded at most
    REMINDED_SECONDS ago. A missing or corrupt file is no record."""
    if not path:
        return False
    for row in _read_denies(path):
        ts = row.get("ts")
        if (
            row.get("session") == session
            and row.get("target") == target_id
            and isinstance(ts, (int, float))
            and 0 <= now - ts <= REMINDED_SECONDS
        ):
            return True
    return False


def remember_deny(path, session, target_id, now):
    """Record a deny and drop records older than DENIES_KEEP_SECONDS. A failure here
    is swallowed: it must never change a decision."""
    if not path:
        return
    try:
        rows = [
            r
            for r in _read_denies(path)
            if isinstance(r.get("ts"), (int, float)) and 0 <= now - r["ts"] <= DENIES_KEEP_SECONDS
        ]
        rows.append({"session": session, "target": target_id, "ts": now})
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rows, fh)
    except Exception:
        pass


# --- the decision ----------------------------------------------------------


def _decision(decision, reason, target=None, idle_s=None, tokens=None, message=None):
    return {
        "decision": decision,
        "reason": reason,
        "target": target,
        "idle_s": idle_s,
        "tokens": tokens,
        "message": message,
    }


def decide(data, config, now):
    """The guard's verdict for one hook input: a dict with `decision` (pass, deny
    or override), `reason` (why), the target and its idle seconds and tokens, and
    `message` for a deny. A deny is remembered, and the next send to the same target
    in the same session within REMINDED_SECONDS passes as `reminded`. Returns None when the call is not a SendMessage."""
    if data.get("tool_name") != "SendMessage":
        return None
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return _decision("pass", "no-tool-input")
    message = tool_input.get("message")
    to = message_target(tool_input)
    if not isinstance(message, str):
        return _decision("pass", "protocol-message", to or None)
    if MARKER in message:
        return _decision("override", "marker", to or None)
    if is_peer_address(to):
        return _decision("pass", "peer-address", to or None)
    sub_dir = subagents_dir(data)
    if not sub_dir:
        return _decision("pass", "no-transcript-path", to)
    if is_engine_fork(data, sub_dir):
        return _decision("pass", "engine-fork", to)
    target = find_target(sub_dir, to)
    if not target:
        return _decision("pass", "no-target", to)
    entries = read_tail(target["path"])
    name = target["name"]
    if is_busy(entries, now):
        return _decision("pass", "busy", name)
    usage = last_usage(entries)
    if not usage:
        return _decision("pass", "no-usage", name)
    idle_s = now - usage[0]
    tokens = usage[1]
    if idle_s <= config["ttl_seconds"]:
        return _decision("pass", "warm", name, idle_s, tokens)
    if tokens < config["min_tokens"]:
        return _decision("pass", "small", name, idle_s, tokens)
    session = session_id(data)
    denies_path = config.get("denies_path")
    if recently_denied(denies_path, session, target["id"], now):
        return _decision("pass", "reminded", name, idle_s, tokens)
    remember_deny(denies_path, session, target["id"], now)
    text = render_message(name, idle_s, tokens, extract_handoff(entries))
    return _decision("deny", "cold", name, idle_s, tokens, text)


def deny_output(reason):
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def log_decision(path, data, verdict, now):
    """Append one JSON line for the decision. A failure here is swallowed."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        record = {
            "ts": datetime.fromtimestamp(now, timezone.utc).isoformat(),
            "session": data.get("session_id"),
            "target": verdict["target"],
            "decision": verdict["decision"],
            "reason": verdict["reason"],
            "idle_s": None if verdict["idle_s"] is None else round(verdict["idle_s"]),
            "tokens": verdict["tokens"],
        }
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception:
        pass


def read_input(stdin=None):
    """The hook JSON from `stdin` (default: stdin's raw bytes), decoded as UTF-8
    whatever the locale; undecodable bytes become U+FFFD."""
    raw = (sys.stdin.buffer if stdin is None else stdin).read()
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    return json.loads(raw)


def main(stdin=None, stdout=None, env=None, now=None):
    """Read the hook JSON, print a deny when one is due. Exits 0 with no output on
    any error, so a fault in the guard never blocks a message."""
    try:
        data = read_input(stdin)
        env = os.environ if env is None else env
        now = time.time() if now is None else now
        config = resolve_config(env, data.get("cwd"))
        verdict = decide(data, config, now)
        if verdict is None:
            return 0
        if config["log_events"]:
            log_decision(config["log_path"], data, verdict, now)
        if verdict["decision"] == "deny":
            out = stdout or sys.stdout
            out.write(json.dumps(deny_output(verdict["message"])))
            out.flush()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
