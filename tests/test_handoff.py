import json

from cold_wake_guard import (
    extract_handoff,
    find_commits,
    find_edited,
    find_last_tests,
    find_read,
    find_report,
    find_test_command,
    parse_test_result,
)
from helpers import AB, APF, bash, fixture_entries, lines_through_result, tool_result, tool_use

GIT = "git -c user.email=26359601+nj-io@users.noreply.github.com -c user.name=nj-io"


def paths_of(tool, paths):
    return [tool_use("id%d" % i, tool, {"file_path": p}) for i, p in enumerate(paths)]


# --- edited, read, report ---------------------------------------------------


def test_edited_is_newest_first_and_unique_and_includes_writes():
    edited = find_edited(fixture_entries(AB))
    assert [p.rsplit("/", 1)[1] for p in edited] == [
        "transcript.py",
        "test_transcript.py",
        "step-2-report.md",
    ]


def test_edited_is_capped_at_ten_newest_first():
    entries = paths_of("Edit", ["/f/%02d.py" % i for i in range(12)] + ["/f/00.py"])
    edited = find_edited(entries)
    assert len(edited) == 10
    assert edited[:3] == ["/f/00.py", "/f/11.py", "/f/10.py"]


def test_notebook_edit_counts_as_an_edit():
    assert find_edited(paths_of("NotebookEdit", ["/n/a.ipynb"])) == ["/n/a.ipynb"]


def test_read_excludes_edited_files_and_keeps_the_rest():
    read = find_read(fixture_entries(AB))
    assert [p.rsplit("/", 1)[1] for p in read] == ["replays.py"]


def test_read_is_capped_at_ten():
    entries = paths_of("Read", ["/r/%02d.py" % i for i in range(12)])
    assert find_read(entries) == ["/r/%02d.py" % i for i in range(11, 1, -1)]


def test_read_drops_image_files_whatever_their_case():
    paths = ["/r/a.py", "/r/shot.png", "/r/b.JPG", "/r/c.jpeg", "/r/d.gif", "/r/e.WebP", "/r/f.svg", "/r/png.md", "/r/g.py"]
    assert find_read(paths_of("Read", paths)) == ["/r/g.py", "/r/png.md", "/r/a.py"]


def test_report_is_the_newest_write_matching_report_md():
    entries = (
        paths_of("Write", ["/a/old-report-1.md"])
        + paths_of("Write", ["/b/step-report-2026-10-20.md"])
        + paths_of("Write", ["/c/notes.md", "/c/report.txt"])
        + paths_of("Edit", ["/d/report-edit.md"])
    )
    assert find_report(entries) == "/b/step-report-2026-10-20.md"


def test_report_from_the_real_transcript_and_none_when_absent():
    assert find_report(fixture_entries(AB)).endswith("step-2-report.md")
    assert find_report(fixture_entries(APF)) is None  # step-1.md has no "report" in its name


# --- commits ----------------------------------------------------------------


def test_commit_q_followed_by_git_log_gives_the_short_sha():
    # The first commit in the real transcript: `commit -q ... && git log --oneline -1`.
    first = [json.loads(l) for l in lines_through_result(AB, "toolu_011eB2sh1vWGwAaM71sy2G1H")]
    assert find_commits(first) == ["f32abb6"]


def test_commits_are_newest_first_and_capped_at_three():
    assert find_commits(fixture_entries(AB)) == ["d7cf145", "586dc55", "edd8511"]


def test_commit_bracket_form_is_read_from_the_output():
    out = "[feat/v1 1a2b3c4] fix: thing\n 1 file changed, 2 insertions(+)"
    entries = bash("c1", GIT + ' commit -m "fix: thing"', out)
    assert find_commits(entries) == ["1a2b3c4"]


def test_bracket_form_wins_over_a_oneline_line():
    out = "abcdef0 an earlier line\n[main (root-commit) 1234567] first"
    assert find_commits(bash("c1", "git commit -m first", out)) == ["1234567"]


def test_commit_shas_are_shortened_to_eight_characters_before_dedup():
    full = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"
    entries = bash("c1", "git commit -m a", "[main %s] a" % full) + bash("c2", "git commit -m b", "%s b" % full[:12])
    assert find_commits(entries) == [full[:8]]
    assert find_commits(bash("c3", "git commit -m c", "%s c" % full)) == ["1a2b3c4d"]


def test_a_command_that_is_not_a_commit_yields_no_sha():
    entries = bash("c1", "git log --oneline -3", "abc1234 something\ndef5678 else")
    assert find_commits(entries) == []


def test_a_failed_commit_yields_no_sha():
    entries = bash("c1", "git commit -m x", "nothing to commit, working tree clean")
    assert find_commits(entries) == []


def test_tool_result_content_as_a_block_list_is_read():
    entries = [
        tool_use("c1", "Bash", {"command": "git commit -q -m x && git log --oneline -1"}),
        tool_result("c1", [{"type": "text", "text": "9f8e7d6 feat: x"}]),
    ]
    assert find_commits(entries) == ["9f8e7d6"]


# --- last tests -------------------------------------------------------------


def test_last_tests_from_the_real_transcript():
    # The command follows `cd … && PY=… &&`, runs through $PY, and pipes to tail.
    command, result = find_last_tests(fixture_entries(AB))
    assert command == "$PY -m pytest tests/test_example.py -q -p no:randomly"
    assert result == "2 failed, 33 passed"


def test_last_tests_with_a_full_python_path_and_error_counts():
    command, result = find_last_tests(fixture_entries(APF))
    assert command.endswith("bin/python -m pytest tests/test_one.py tests/test_two.py -q -p no:cacheprovider")
    assert result == "1 failed, 37 passed, 17 errors"


def test_pytest_summary_keeps_only_passed_failed_error_counts():
    # Real output of a `-k` run: the deselected count is dropped.
    assert parse_test_result("====================== 2 failed, 121 deselected in 1.17s =======================") == "2 failed"


def test_vitest_summary_line():
    out = "\x1b[2m Test Files \x1b[22m 1 failed (2)\n      Tests  3 failed | 12 passed (15)\n"
    assert parse_test_result(out) == "3 failed | 12 passed (15)"


def test_no_summary_line_reads_result_not_shown():
    entries = bash("t1", "cd /p && go test ./...", "ok  \texample.com/p\t0.012s")
    assert find_last_tests(entries) == ("go test ./...", "result not shown")


def test_the_last_test_command_wins():
    entries = bash("t1", "pytest -q", "5 passed in 0.1s") + bash("t2", "ls", "x") + bash("t3", "python3 -m pytest tests/ -q", "1 failed in 0.2s")
    assert find_last_tests(entries) == ("python3 -m pytest tests/ -q", "1 failed")


def test_no_test_command_gives_none():
    assert find_last_tests(bash("t1", "grep -n pytest setup.cfg", "pytest>=7")) is None


def test_test_commands_are_recognised_after_cd_and_env_assignments():
    assert find_test_command("cd /w && FOO=1 BAR=$(pwd)/src python3 -m pytest -q 2>&1 | tail") == "python3 -m pytest -q"
    assert find_test_command("export A=1; P=/x/python; $P -m pytest t.py") == "$P -m pytest t.py"
    assert find_test_command("export A=1 && pytest -q") == "pytest -q"
    assert find_test_command("npx vitest run --reporter=dot") == "npx vitest run --reporter=dot"
    assert find_test_command("npm run test -- --watch=false") == "npm run test -- --watch=false"
    assert find_test_command("cd s && go test ./... | tail -3") == "go test ./..."
    assert find_test_command("cargo test --release") == "cargo test --release"


def test_non_test_commands_are_not_recognised():
    for command in ("grep -n pytest a.py", "echo pytest", "ls tests", "git commit -m 'pytest fix'"):
        assert find_test_command(command) is None


def test_extract_handoff_collects_every_fact():
    handoff = extract_handoff(fixture_entries(AB))
    assert set(handoff) == {"report", "edited", "read", "commits", "last_tests"}
    assert handoff["commits"][0] == "d7cf145" and handoff["report"] and handoff["last_tests"]
