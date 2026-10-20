import json
import os
import shutil

from cold_wake_guard import decide, parse_timestamp
from helpers import (
    tool_result,
    AB,
    APF,
    NOW,
    RECHECK,
    config,
    fixture_lines,
    iso,
    lines_through_tool_use,
    synthetic_entry,
    usage_entry,
    Session,
)

COLD = NOW + 1200  # 20 minutes after the fixtures' last request


def ab_session(tmp_path, **kw):
    s = Session(tmp_path)
    s.add_fixture(AB, **kw)
    return s


def verdict(s, to, now=COLD, cfg=None, **hook_kw):
    return decide(s.hook_input(to, **hook_kw), cfg or config(), now)


def test_cold_agent_with_enough_context_is_denied_with_the_handoff(tmp_path):
    v = verdict(ab_session(tmp_path), "b1-2")
    assert (v["decision"], v["reason"], v["target"]) == ("deny", "cold", "b1-2")
    assert (v["idle_s"], v["tokens"]) == (1200, 157462)
    assert v["message"].startswith("b1-2 has been idle 20 min and its cache has expired.")
    assert "- Commits: d7cf145, 586dc55, edd8511" in v["message"]


def test_exact_name_beats_a_newer_prefix_sibling_end_to_end(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(APF, mtime=NOW - 1000)
    s.add_fixture(RECHECK, mtime=NOW - 10)
    v = verdict(s, "pf-s1")
    assert v["decision"] == "deny" and v["tokens"] == 315763 and v["message"].startswith("pf-s1 has been idle")


def test_the_agent_id_is_accepted_as_the_target(tmp_path):
    v = verdict(ab_session(tmp_path), "ab1-2-c26abe268834c1bc")
    assert v["decision"] == "deny" and v["target"] == "b1-2"


def test_the_recipient_key_is_read_when_there_is_no_to(tmp_path):
    s = ab_session(tmp_path)
    data = s.hook_input("ignored")
    data["tool_input"] = {"recipient": "b1-2", "message": "go"}
    assert decide(data, config(), COLD)["decision"] == "deny"


def test_an_unknown_target_passes(tmp_path):
    v = verdict(ab_session(tmp_path), "someone-else")
    assert (v["decision"], v["reason"]) == ("pass", "no-target")


def test_protocol_messages_pass(tmp_path):
    shutdown = {"type": "shutdown_request", "reason": "done"}
    v = verdict(ab_session(tmp_path), "b1-2", message=shutdown)
    assert (v["decision"], v["reason"]) == ("pass", "protocol-message")


def test_the_marker_is_an_override(tmp_path):
    v = verdict(ab_session(tmp_path), "b1-2", message="continue [cold-resume-ok] with step 2")
    assert (v["decision"], v["reason"], v["target"]) == ("override", "marker", "b1-2")


def test_a_warm_agent_passes(tmp_path):
    v = verdict(ab_session(tmp_path), "b1-2", now=NOW + 120)
    assert (v["decision"], v["reason"], v["idle_s"]) == ("pass", "warm", 120)


def test_idle_must_exceed_the_ttl_strictly(tmp_path):
    s = ab_session(tmp_path)
    assert verdict(s, "b1-2", now=NOW + 300)["decision"] == "pass"
    assert verdict(s, "b1-2", now=NOW + 301)["decision"] == "deny"


def test_a_small_context_passes(tmp_path):
    v = verdict(ab_session(tmp_path), "b1-2", cfg=config(min_tokens=200_000))
    assert (v["decision"], v["reason"], v["tokens"]) == ("pass", "small", 157462)


def test_the_token_threshold_is_inclusive(tmp_path):
    assert verdict(ab_session(tmp_path), "b1-2", cfg=config(min_tokens=157462))["decision"] == "deny"


def dangling_tool_use_session(tmp_path):
    """The real transcript cut at the assistant entry that starts the report Write,
    and the epoch seconds of that entry."""
    s = Session(tmp_path)
    lines = lines_through_tool_use(AB, "toolu_01FbWF8yV5hxJRS6SY1jfdrC")
    s.add_agent("ab1-2-busy", "b1-2", lines)
    return s, parse_timestamp(json.loads(lines[-1])["timestamp"])


def test_a_busy_agent_passes(tmp_path):
    s, started = dangling_tool_use_session(tmp_path)
    v = verdict(s, "b1-2", now=started + 120)
    assert (v["decision"], v["reason"]) == ("pass", "busy")


def test_a_tool_call_of_any_age_is_busy(tmp_path):
    # A nested Agent call or a permission prompt has no upper bound.
    s, started = dangling_tool_use_session(tmp_path)
    for age in (600, 601, 2000, 86_400 * 3):
        v = verdict(s, "b1-2", now=started + age)
        assert (v["decision"], v["reason"]) == ("pass", "busy"), age


def result_cut_session(tmp_path):
    """A 200K-token agent whose last request was 25 minutes before the tool result
    that ends its transcript (a long tool call), and the result's epoch seconds."""
    s = Session(tmp_path)
    lines = [
        json.dumps(usage_entry(iso(NOW - 1500), 200_000, tool_use=("t1", "Agent", {}))),
        json.dumps(tool_result("t1", "done", ts=iso(NOW))),
    ]
    s.add_agent("long-1", "long", lines)
    return s


def test_a_fresh_tool_result_is_the_model_answering_so_the_agent_is_busy(tmp_path):
    s = result_cut_session(tmp_path)
    v = verdict(s, "long", now=NOW + 10)
    assert (v["decision"], v["reason"]) == ("pass", "busy")
    assert verdict(s, "long", now=NOW + 600)["reason"] == "busy"


def test_a_trailing_user_entry_older_than_ten_minutes_is_not_busy(tmp_path):
    s = result_cut_session(tmp_path)
    v = verdict(s, "long", now=NOW + 700)
    assert (v["decision"], v["reason"], v["tokens"]) == ("deny", "cold", 200_000)
    assert verdict(s, "long", now=NOW + 601)["reason"] == "cold"


def test_a_synthetic_entry_after_a_session_limit_does_not_hide_a_cold_agent(tmp_path):
    s = Session(tmp_path)
    lines = [
        json.dumps(usage_entry(iso(NOW - 2000), 200_000)),
        json.dumps(synthetic_entry(iso(NOW - 1000))),
    ]
    s.add_agent("limit-1", "limited", lines)
    v = verdict(s, "limited", now=NOW)
    assert (v["decision"], v["tokens"], v["idle_s"]) == ("deny", 200_000, 2000)
    assert v["message"].startswith("limited has been idle 33 min")
    assert "200K-token" in v["message"]


def test_a_transcript_without_usage_passes(tmp_path):
    s = Session(tmp_path)
    stale = {"type": "user", "timestamp": iso(NOW - 5000), "message": {"role": "user", "content": "hi"}}
    s.add_agent("x1", "quiet", [json.dumps(stale)])
    assert verdict(s, "quiet")["reason"] == "no-usage"


def test_main_team_lead_and_empty_targets_pass_even_when_an_agent_has_that_name(tmp_path):
    s = Session(tmp_path)
    for i, name in enumerate(("main", "team-lead")):
        s.add_agent("ab1-2-%d" % i, name, fixture_lines(AB))
    assert verdict(s, "main")["reason"] == "peer-address"
    assert verdict(s, "team-lead")["reason"] == "peer-address"
    assert verdict(s, "")["reason"] == "peer-address"


def test_peer_session_addresses_pass_even_when_an_agent_has_that_name(tmp_path):
    s = Session(tmp_path)
    for i, name in enumerate(("worker [3fa9c1]", "name@session", "uds:/tmp/a.sock")):
        s.add_agent("ab1-2-%d" % i, name, fixture_lines(AB))
        assert verdict(s, name)["reason"] == "peer-address", name


def test_a_tool_other_than_sendmessage_is_not_judged(tmp_path):
    s = ab_session(tmp_path)
    assert decide(s.hook_input("b1-2", tool_name="Bash"), config(), COLD) is None


def test_missing_transcript_path_passes(tmp_path):
    s = ab_session(tmp_path)
    data = s.hook_input("b1-2")
    del data["transcript_path"]
    assert decide(data, config(), COLD)["reason"] == "no-transcript-path"


def test_missing_session_id_falls_back_to_the_transcript_name(tmp_path):
    s = ab_session(tmp_path)
    data = s.hook_input("b1-2")
    del data["session_id"]
    assert decide(data, config(), COLD)["decision"] == "deny"


def test_missing_tool_input_and_missing_to_pass(tmp_path):
    s = ab_session(tmp_path)
    data = s.hook_input("b1-2")
    del data["tool_input"]
    assert decide(data, config(), COLD)["decision"] == "pass"
    data["tool_input"] = {"message": "hello"}
    assert decide(data, config(), COLD)["reason"] == "peer-address"
    data["tool_input"] = "not a dict"
    assert decide(data, config(), COLD)["decision"] == "pass"


def test_a_missing_subagents_directory_passes(tmp_path):
    s = ab_session(tmp_path)
    shutil.rmtree(s.sub_dir)
    assert verdict(s, "b1-2")["reason"] == "no-target"


def test_only_the_last_4_mib_of_the_transcript_feeds_the_handoff(tmp_path, big_transcript):
    s = Session(tmp_path)
    s.add_agent("big-1", "big", ["{}"])
    shutil.copy(big_transcript, os.path.join(s.sub_dir, "agent-big-1.jsonl"))
    v = verdict(s, "big")
    assert (v["decision"], v["tokens"]) == ("deny", 200_000)
    assert "- Edited: /tail/only.py\n" in v["message"] + "\n"
    assert "/head/only.py" not in v["message"]


def test_an_engine_fork_sender_passes(tmp_path):
    # agent_id is set but has no meta file in subagents/: a fork such as prompt suggestion.
    s = ab_session(tmp_path)
    v = verdict(s, "b1-2", agent_id="aprompt-suggestion-0123456789abcdef")
    assert (v["decision"], v["reason"]) == ("pass", "engine-fork")


def test_a_teammate_sender_with_a_meta_file_stays_guarded(tmp_path):
    s = ab_session(tmp_path)
    s.add_fixture(APF)  # the sender's own meta file exists
    v = verdict(s, "b1-2", agent_id="apf-s1-98a645c87eafa25d")
    assert (v["decision"], v["reason"]) == ("deny", "cold")


def test_an_empty_agent_id_is_the_main_loop(tmp_path):
    assert verdict(ab_session(tmp_path), "b1-2", agent_id="")["decision"] == "deny"
