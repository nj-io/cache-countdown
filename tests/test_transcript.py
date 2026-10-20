import json

import pytest

from cold_wake_guard import is_busy, last_usage, parse_timestamp, read_tail
from helpers import AB, NOW, fixture_entries, iso, synthetic_entry, tool_result, tool_use, usage_entry

def uuids(entries):
    return [e.get("uuid") for e in entries]


def test_tail_read_skips_everything_before_the_last_4_mib(big_transcript):
    entries = read_tail(big_transcript)
    assert "head-entry" not in uuids(entries)
    assert "tail-final" in uuids(entries)
    assert last_usage(entries) == (NOW, 200_000)


def test_tail_read_drops_the_partial_first_line(big_transcript):
    # The window starts inside the long line; its suffix is valid JSON with a 2099 timestamp.
    assert "partial-line" not in uuids(read_tail(big_transcript))


def test_a_line_that_starts_exactly_at_the_window_is_kept(tmp_path):
    path = tmp_path / "t.jsonl"
    lines = [json.dumps({"uuid": u}) + "\n" for u in ("a", "b", "c")]
    path.write_text("".join(lines))
    window = len(lines[1]) + len(lines[2])
    assert uuids(read_tail(str(path), max_bytes=window)) == ["b", "c"]


def test_a_small_file_is_read_whole_and_junk_lines_are_skipped(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text('{"uuid": "a"}\nnot json\n[1, 2]\n{"uuid": "b"}\n')
    assert uuids(read_tail(str(path))) == ["a", "b"]


def test_unreadable_transcript_raises_for_main_to_swallow(tmp_path):
    with pytest.raises(OSError):
        read_tail(str(tmp_path))  # a directory


def test_last_usage_is_input_plus_cache_read_plus_cache_creation():
    entries = fixture_entries(AB)
    assert last_usage(entries) == (NOW, 157462)  # 2 + 156591 + 869 in the real entry


def test_last_usage_skips_entries_without_usage_or_timestamp():
    entries = [
        usage_entry("2026-01-01T11:00:00.000Z", 70_000),
        {"type": "user", "timestamp": "2026-01-01T11:30:00.000Z", "message": {"content": "hi"}},
        {"type": "assistant", "message": {"usage": {"input_tokens": 5}}},
    ]
    assert last_usage(entries) == (NOW - 3600, 70_000)
    assert last_usage([]) is None


def test_last_usage_skips_a_synthetic_entry_even_when_it_carries_tokens():
    entries = [usage_entry("2026-01-01T11:00:00.000Z", 70_000), synthetic_entry("2026-01-01T11:30:00.000Z", tokens=5)]
    assert last_usage(entries) == (NOW - 3600, 70_000)


def test_last_usage_skips_an_all_zero_entry_from_a_real_model():
    entries = [usage_entry("2026-01-01T11:00:00.000Z", 70_000), synthetic_entry("2026-01-01T11:30:00.000Z", model="example-model")]
    assert last_usage(entries) == (NOW - 3600, 70_000)
    assert last_usage([synthetic_entry("2026-01-01T11:30:00.000Z")]) is None


def test_parse_timestamp_accepts_z_and_offsets_and_rejects_junk():
    assert parse_timestamp("2026-01-01T12:00:00.000Z") == NOW
    assert parse_timestamp("2026-01-01T13:00:00+01:00") == NOW
    assert parse_timestamp("yesterday") is None and parse_timestamp(None) is None


def test_busy_when_the_last_message_is_a_tool_use_without_a_result():
    entries = [usage_entry("2026-01-01T11:00:00.000Z", 60_000), tool_use("t1", "Bash", {"command": "sleep 60"})]
    entries.append({"type": "attachment", "attachment": {"type": "total_tokens_reminder"}})
    assert is_busy(entries)


def test_a_tool_use_is_busy_at_any_age():
    entries = [tool_use("t1", "Agent", {}) | {"timestamp": iso(NOW)}]
    assert is_busy(entries, NOW + 86_400)


def test_a_trailing_tool_result_is_busy_for_ten_minutes():
    entries = [tool_use("t1", "Bash", {"command": "ls"}), tool_result("t1", "ok", ts=iso(NOW))]
    assert is_busy(entries, NOW + 10)
    assert is_busy(entries, NOW + 600)
    assert not is_busy(entries, NOW + 601)


def test_a_trailing_user_entry_without_a_timestamp_or_a_clock_is_busy():
    entries = [tool_use("t1", "Bash", {"command": "ls"}), tool_result("t1", "ok")]
    assert is_busy(entries, NOW)
    assert is_busy(entries)


def test_not_busy_without_messages():
    assert not is_busy([])
    assert not is_busy([{"type": "attachment", "attachment": {}}])


def test_not_busy_when_the_last_message_is_text():
    entries = [tool_use("t1", "Bash", {}), tool_result("t1", "ok"), usage_entry("2026-01-01T11:00:00.000Z", 60_000)]
    assert not is_busy(entries, NOW)
    assert not is_busy(entries)
