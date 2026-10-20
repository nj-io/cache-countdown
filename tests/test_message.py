import os

from cold_wake_guard import extract_handoff, format_idle, render_message
from helpers import AB, APF, GOLDEN, fixture_entries

EMPTY = {"report": None, "edited": [], "read": [], "commits": [], "last_tests": None}


def golden(name):
    with open(os.path.join(GOLDEN, name)) as fh:
        return fh.read()


def test_golden_message_with_every_handoff_line():
    entries = fixture_entries(AB)
    message = render_message("b1-2", 1200, 157462, extract_handoff(entries))
    assert message == golden("deny_b1_2.txt")


def test_golden_message_omits_the_lines_that_were_not_found():
    # pf-s1 wrote no *report*.md; it did commit and run tests.
    message = render_message("pf-s1", 1830, 315763, extract_handoff(fixture_entries(APF)))
    assert message == golden("deny_pf_s1.txt")
    assert "Report:" not in message


def test_report_commits_and_tests_lines_are_omitted_when_not_found():
    message = render_message("x", 600, 60000, EMPTY)
    assert "Report:" not in message and "Commits:" not in message and "Last tests:" not in message
    assert "(only if found)" not in message


def test_edited_and_read_say_none_when_empty():
    message = render_message("x", 600, 60000, EMPTY)
    assert message.endswith("- Edited: none\n- Read: none")


def test_minutes_are_floored_and_tokens_are_in_thousands():
    message = render_message("x", 1199.9, 60999, EMPTY)
    assert message.startswith("x has been idle 19 min and its cache has expired.")
    assert "its 60K-token conversation" in message and "re-reads all 60K." in message


def test_the_resume_option_names_the_override_marker():
    assert "- **Resume** (re-send with [cold-resume-ok]) if the next task" in render_message("x", 600, 60000, EMPTY)


def test_idle_is_shown_in_minutes_up_to_120_then_hours_then_days():
    cases = {
        0: "0 min",
        1199.9: "19 min",
        120 * 60: "120 min",
        121 * 60: "2 h",
        6 * 3600 + 1800: "6 h",
        48 * 3600: "48 h",
        49 * 3600: "2 days",
        15 * 86400 + 7200: "15 days",
    }
    for seconds, text in cases.items():
        assert format_idle(seconds) == text, seconds


def test_the_message_names_hours_and_days():
    assert render_message("x", 6 * 3600 + 120, 60000, EMPTY).startswith("x has been idle 6 h and its cache has expired.")
    assert render_message("x", 15 * 86400, 60000, EMPTY).startswith("x has been idle 15 days and its cache has expired.")
