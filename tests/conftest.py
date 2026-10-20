import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hooks"))
sys.path.insert(0, os.path.dirname(__file__))

import cold_wake_guard  # noqa: E402
from helpers import tool_result, usage_entry  # noqa: E402

MIB = 1024 * 1024


@pytest.fixture(autouse=True)
def no_machine_managed_settings(monkeypatch):
    """The suite never reads this machine's managed settings file."""
    monkeypatch.setattr(cold_wake_guard, "managed_settings_paths", lambda env=None: [])
PAD = json.dumps({"type": "user", "message": {"role": "user", "content": "p" * 1000}}) + "\n"
BOGUS = json.dumps(
    {
        "type": "assistant",
        "uuid": "partial-line",
        "timestamp": "2099-01-01T00:00:00.000Z",
        "message": {"role": "assistant", "content": [{"type": "text", "text": "x"}], "usage": {"input_tokens": 999}},
    }
)


def edit_entry(uuid, path, ts, tokens):
    entry = usage_entry(ts, tokens, tool_use=("t-" + uuid, "Edit", {"file_path": path}), uuid=uuid)
    return json.dumps(entry) + "\n"


@pytest.fixture(scope="session")
def big_transcript(tmp_path_factory):
    """About 5.5 MiB: a head entry, 1 MiB of padding, one 3.5 MiB line (blanks, then a
    JSON entry, so the part of it inside the 4 MiB window parses on its own), then
    1 MiB of padding and a tail that ends in the last usage entry."""
    path = tmp_path_factory.mktemp("big") / "big.jsonl"
    with open(path, "w") as fh:
        fh.write(edit_entry("head-entry", "/head/only.py", "2026-01-01T00:00:00.000Z", 100_000))
        fh.write(PAD * 1050)
        fh.write(" " * int(3.5 * MIB) + BOGUS + "\n")
        fh.write(PAD * 1050)
        fh.write(edit_entry("tail-edit", "/tail/only.py", "2026-01-01T11:59:00.000Z", 150_000))
        fh.write(json.dumps(tool_result("t-tail-edit", "ok")) + "\n")
        fh.write(json.dumps(usage_entry("2026-01-01T12:00:00.000Z", 200_000, uuid="tail-final")) + "\n")
    assert path.stat().st_size > 5 * MIB
    return str(path)


