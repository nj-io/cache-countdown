import io
import json
import os
import subprocess
import sys

from cold_wake_guard import main
from helpers import AB, APF, NOW, Session, fixture_lines

HOOK = os.path.join(os.path.dirname(__file__), "..", "hooks", "cold_wake_guard.py")
COLD = NOW + 1200


def run(data, env, now=COLD):
    stdin = io.StringIO(data if isinstance(data, str) else json.dumps(data))
    stdout = io.StringIO()
    code = main(stdin=stdin, stdout=stdout, env=env, now=now)
    return code, stdout.getvalue()


def read_log(path):
    with open(path) as fh:
        return [json.loads(line) for line in fh]


def test_deny_prints_the_hook_decision_json_and_exits_zero(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    code, out = run(s.hook_input("b1-2"), {"HOME": str(tmp_path)})
    assert code == 0
    body = json.loads(out)
    assert list(body) == ["hookSpecificOutput"]
    out_fields = body["hookSpecificOutput"]
    assert out_fields["hookEventName"] == "PreToolUse"
    assert out_fields["permissionDecision"] == "deny"
    assert out_fields["permissionDecisionReason"].startswith("b1-2 has been idle 20 min")


def test_a_pass_prints_nothing(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    assert run(s.hook_input("b1-2"), {"HOME": str(tmp_path)}, now=NOW + 60) == (0, "")


def test_a_tool_other_than_sendmessage_prints_nothing(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    data = s.hook_input("b1-2", tool_name="Bash")
    assert run(data, {"HOME": str(tmp_path)}) == (0, "")


def test_garbage_and_empty_stdin_fail_open(tmp_path):
    env = {"HOME": str(tmp_path)}
    assert run("{not json", env) == (0, "")
    assert run("", env) == (0, "")
    assert run("[1, 2]", env) == (0, "")


def test_an_unreadable_transcript_fails_open(tmp_path):
    s = Session(tmp_path)
    path = s.add_fixture(AB)
    os.remove(path)
    os.mkdir(path)  # the meta file still names it; opening a directory raises
    assert run(s.hook_input("b1-2"), {"HOME": str(tmp_path)}) == (0, "")


def test_log_events_appends_one_json_line_per_decision(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    env = {"HOME": str(tmp_path), "CLAUDE_PLUGIN_OPTION_LOG_EVENTS": "true"}
    run(s.hook_input("b1-2"), env)
    run(s.hook_input("b1-2", message="go [cold-resume-ok]"), env)
    run(s.hook_input("b1-2"), env, now=NOW + 60)
    rows = read_log(tmp_path / ".claude" / "logs" / "cache" / "guard.jsonl")
    assert [(r["decision"], r["reason"]) for r in rows] == [("deny", "cold"), ("override", "marker"), ("pass", "warm")]
    assert rows[0] == {
        "ts": "2026-01-01T12:20:00+00:00",
        "session": "sess-1",
        "target": "b1-2",
        "decision": "deny",
        "reason": "cold",
        "idle_s": 1200,
        "tokens": 157462,
    }
    assert rows[1]["idle_s"] is None and rows[1]["tokens"] is None


def test_nothing_is_logged_unless_log_events_is_on(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    run(s.hook_input("b1-2"), {"HOME": str(tmp_path)})
    assert not (tmp_path / ".claude" / "logs" / "cache" / "guard.jsonl").exists()


def test_a_log_failure_keeps_the_deny(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / "logs").write_text("a file where the log directory should go")
    env = {"HOME": str(tmp_path), "CLAUDE_CONFIG_DIR": str(cfg), "CLAUDE_PLUGIN_OPTION_LOG_EVENTS": "true"}
    code, out = run(s.hook_input("b1-2"), env)
    assert code == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_the_script_runs_as_a_command_on_stdin(tmp_path):
    # The real entry point. Only this test reads the wall clock indirectly: the
    # fixture's last request is in January 2026, so it is cold at any later time.
    s = Session(tmp_path)
    s.add_fixture(APF)
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path)}
    proc = subprocess.run(
        [sys.executable, HOOK], input=json.dumps(s.hook_input("pf-s1")), capture_output=True, text=True, env=env
    )
    assert proc.returncode == 0 and proc.stderr == ""
    assert json.loads(proc.stdout)["hookSpecificOutput"]["permissionDecision"] == "deny"
    garbage = subprocess.run([sys.executable, HOOK], input="nope", capture_output=True, text=True, env=env)
    assert (garbage.returncode, garbage.stdout) == (0, "")


def test_main_reads_the_cwd_from_the_hook_input_for_project_settings(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    project = tmp_path / "project"
    (project / ".claude").mkdir(parents=True)
    (project / ".claude" / "settings.local.json").write_text('{"subagentPromptCacheTtl": "1h"}')
    env = {"HOME": str(tmp_path)}
    assert run(s.hook_input("b1-2", cwd=str(project)), env)[1] == ""  # 20 min idle < 1 h
    assert json.loads(run(s.hook_input("b1-2"), env)[1])["hookSpecificOutput"]["permissionDecision"] == "deny"


# --- one-shot deny -----------------------------------------------------------


def denied(output):
    return bool(output) and json.loads(output)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_a_resend_right_after_a_deny_passes_as_reminded_and_is_logged(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    env = {"HOME": str(tmp_path), "CLAUDE_PLUGIN_OPTION_LOG_EVENTS": "true"}
    assert denied(run(s.hook_input("b1-2"), env)[1])
    assert run(s.hook_input("b1-2"), env, now=COLD + 30) == (0, "")
    rows = read_log(tmp_path / ".claude" / "logs" / "cache" / "guard.jsonl")
    assert [(r["decision"], r["reason"]) for r in rows] == [("deny", "cold"), ("pass", "reminded")]


def test_the_reminder_lasts_900_seconds(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    env = {"HOME": str(tmp_path)}
    assert denied(run(s.hook_input("b1-2"), env)[1])
    assert run(s.hook_input("b1-2"), env, now=COLD + 900) == (0, "")
    assert denied(run(s.hook_input("b1-2"), env, now=COLD + 901)[1])


def test_another_target_or_session_is_still_denied(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    s.add_fixture(APF)
    env = {"HOME": str(tmp_path)}
    assert denied(run(s.hook_input("b1-2"), env)[1])
    assert denied(run(s.hook_input("pf-s1"), env, now=COLD + 5)[1])
    other = Session(tmp_path / "other", session_id="sess-2")
    other.add_fixture(AB)
    assert denied(run(other.hook_input("b1-2"), env, now=COLD + 10)[1])


def test_an_unwritable_denies_file_still_denies_every_time(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / "logs").write_text("a file where the cache directory should go")
    env = {"HOME": str(tmp_path), "CLAUDE_CONFIG_DIR": str(cfg)}
    assert denied(run(s.hook_input("b1-2"), env)[1])
    assert denied(run(s.hook_input("b1-2"), env, now=COLD + 30)[1])


def test_a_corrupt_denies_file_is_tolerated_and_replaced(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    denies = tmp_path / ".claude" / "logs" / "cache" / "recent-denies.json"
    denies.parent.mkdir(parents=True)
    denies.write_text("{not json")
    env = {"HOME": str(tmp_path)}
    assert denied(run(s.hook_input("b1-2"), env)[1])
    assert run(s.hook_input("b1-2"), env, now=COLD + 30) == (0, "")


def test_denies_older_than_an_hour_are_pruned_when_a_deny_is_recorded(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    denies = tmp_path / ".claude" / "logs" / "cache" / "recent-denies.json"
    denies.parent.mkdir(parents=True)
    denies.write_text(json.dumps([
        {"session": "old", "target": "x", "ts": COLD - 3601},
        {"session": "recent", "target": "y", "ts": COLD - 3000},
    ]))
    assert denied(run(s.hook_input("b1-2"), {"HOME": str(tmp_path)})[1])
    kept = json.loads(denies.read_text())
    assert [(r["session"], r["target"]) for r in kept] == [("recent", "y"), ("sess-1", "ab1-2-c26abe268834c1bc")]


# --- encoding ----------------------------------------------------------------

C_LOCALE = {"PYTHONCOERCECLOCALE": "0", "PYTHONUTF8": "0", "LC_ALL": "C", "LANG": "C"}


def test_non_ascii_meta_and_message_work_under_a_c_locale(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    meta = os.path.join(s.sub_dir, AB + ".meta.json")
    with open(meta, "w", encoding="utf-8") as fh:
        json.dump({"agentType": "fixture", "name": "b1-2", "description": "Extract B1.6\u2013B1.11"}, fh, ensure_ascii=False)
    data = s.hook_input("b1-2", message="go \u2014 now")
    # PYTHONIOENCODING makes a text-mode read of stdin fail the way a Windows code page does.
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "PYTHONIOENCODING": "ascii:strict", **C_LOCALE}
    proc = subprocess.run(
        [sys.executable, HOOK], input=json.dumps(data, ensure_ascii=False).encode("utf-8"), capture_output=True, env=env
    )
    assert proc.returncode == 0 and proc.stderr == b""
    assert denied(proc.stdout.decode("ascii"))


def test_undecodable_stdin_bytes_are_replaced_not_fatal(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(AB)
    raw = json.dumps(s.hook_input("b1-2", message="go XX")).encode("utf-8").replace(b"XX", b"\xff\xfe")
    code, out = main_with_bytes(raw, {"HOME": str(tmp_path)})
    assert code == 0 and denied(out)


def main_with_bytes(raw, env):
    stdout = io.StringIO()
    return main(stdin=io.BytesIO(raw), stdout=stdout, env=env, now=COLD), stdout.getvalue()


def test_non_ascii_settings_are_read_under_a_c_locale(tmp_path):
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "settings.json").write_text(
        json.dumps({"note": "caf\u00e9 \u2014 notes", "subagentPromptCacheTtl": "1h"}, ensure_ascii=False), encoding="utf-8"
    )
    code = "import cold_wake_guard as g; print(g.read_cache_ttl_setting({'HOME': %r}, managed_paths=[]))" % str(tmp_path)
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": os.path.dirname(HOOK), **C_LOCALE}
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    assert proc.stdout.strip() == "1h", proc.stderr
