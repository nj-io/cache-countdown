"""Shared builders. No test reads the wall clock: `NOW` is the fixed fake time, and
every fixture transcript's last usage entry sits at exactly `NOW`."""
import json
import os
import shutil
from datetime import datetime, timezone

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
GOLDEN = os.path.join(HERE, "golden")

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp()

AB = "agent-ab1-2-c26abe268834c1bc"  # name "b1-2": commits, tests, a report, edits
APF = "agent-apf-s1-98a645c87eafa25d"  # name "pf-s1"
RECHECK = "agent-apf-s1-recheck-d35abef42825c86c"  # name "pf-s1-recheck"

DEFAULT_CONFIG = {
    "ttl_seconds": 300,
    "min_tokens": 50_000,
    "log_events": False,
    "log_path": None,
}


def config(**overrides):
    return {**DEFAULT_CONFIG, **overrides}


def fixture_lines(stem):
    with open(os.path.join(FIXTURES, stem + ".jsonl")) as fh:
        return fh.read().splitlines()


def fixture_entries(stem):
    return [json.loads(line) for line in fixture_lines(stem)]


def install_agent(sub_dir, agent_id, name, lines, mtime, meta_mtime=None):
    """Write agent-<id>.jsonl and .meta.json into a subagents directory. The meta
    file's mtime (the spawn time) defaults to the transcript's."""
    path = os.path.join(sub_dir, "agent-%s.jsonl" % agent_id)
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    os.utime(path, (mtime, mtime))
    meta = os.path.join(sub_dir, "agent-%s.meta.json" % agent_id)
    with open(meta, "w") as fh:
        json.dump({"agentType": "fixture", "name": name}, fh)
    meta_mtime = mtime if meta_mtime is None else meta_mtime
    os.utime(meta, (meta_mtime, meta_mtime))
    return path


class Session:
    """A main transcript plus its subagents directory under tmp_path."""

    def __init__(self, tmp_path, session_id="sess-1"):
        self.session_id = session_id
        project = tmp_path / "proj"
        self.sub_dir = str(project / session_id / "subagents")
        os.makedirs(self.sub_dir)
        self.transcript = str(project / (session_id + ".jsonl"))
        with open(self.transcript, "w") as fh:
            fh.write("")

    def add_fixture(self, stem, mtime=NOW - 600, meta_mtime=None):
        """Copy a committed fixture transcript and its meta file in as-is."""
        for ext in (".jsonl", ".meta.json"):
            shutil.copy(os.path.join(FIXTURES, stem + ext), self.sub_dir)
        path = os.path.join(self.sub_dir, stem + ".jsonl")
        os.utime(path, (mtime, mtime))
        meta_mtime = mtime if meta_mtime is None else meta_mtime
        os.utime(os.path.join(self.sub_dir, stem + ".meta.json"), (meta_mtime, meta_mtime))
        return path

    def add_agent(self, agent_id, name, lines, mtime=NOW - 600, meta_mtime=None):
        return install_agent(self.sub_dir, agent_id, name, lines, mtime, meta_mtime)

    def hook_input(self, to, message="please continue", **overrides):
        data = {
            "tool_name": "SendMessage",
            "tool_input": {"to": to, "message": message},
            "transcript_path": self.transcript,
            "session_id": self.session_id,
        }
        data.update(overrides)
        return data


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def synthetic_entry(ts, model="<synthetic>", tokens=0):
    """The assistant entry Claude Code writes after an API error such as a session
    limit: a fake model and all-zero usage."""
    return {
        "type": "assistant",
        "uuid": "synthetic",
        "timestamp": ts,
        "message": {
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "You've hit your session limit"}],
            "usage": {"input_tokens": tokens, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        },
    }


def usage_entry(ts, tokens, tool_use=None, text="done", uuid="u"):
    """A synthetic assistant entry with usage; `tool_use` is (id, name, input)."""
    if tool_use:
        block = {"type": "tool_use", "id": tool_use[0], "name": tool_use[1], "input": tool_use[2]}
    else:
        block = {"type": "text", "text": text}
    return {
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
        "message": {
            "role": "assistant",
            "content": [block],
            "usage": {"input_tokens": 1, "cache_read_input_tokens": tokens - 1, "cache_creation_input_tokens": 0},
        },
    }


def tool_use(tool_id, name, inp):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tool_id, "name": name, "input": inp}]}}


def tool_result(tool_id, content, ts=None):
    entry = {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": content}]}}
    if ts:
        entry["timestamp"] = ts
    return entry


def bash(tool_id, command, output):
    return [tool_use(tool_id, "Bash", {"command": command}), tool_result(tool_id, output)]


def lines_through_tool_use(stem, tool_use_id):
    """The fixture's lines up to and including the assistant entry for `tool_use_id`."""
    out = []
    for line in fixture_lines(stem):
        out.append(line)
        if '"id": "%s"' % tool_use_id in line:
            return out
    raise AssertionError(tool_use_id)


def lines_through_result(stem, tool_use_id):
    out = []
    for line in fixture_lines(stem):
        out.append(line)
        if '"tool_use_id": "%s"' % tool_use_id in line:
            return out
    raise AssertionError(tool_use_id)
