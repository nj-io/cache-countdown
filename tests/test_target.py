import os

from cold_wake_guard import find_target
from helpers import APF, RECHECK, NOW, Session, fixture_lines

APF_ID = "apf-s1-98a645c87eafa25d"
RECHECK_ID = "apf-s1-recheck-d35abef42825c86c"


def two_siblings(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(APF, mtime=NOW - 1000)
    s.add_fixture(RECHECK, mtime=NOW - 10)  # the newer transcript
    return s


def test_exact_name_beats_a_newer_prefix_sibling(tmp_path):
    # C1: "pf-s1" is a prefix of "pf-s1-recheck", whose transcript is newer.
    target = find_target(two_siblings(tmp_path).sub_dir, "pf-s1")
    assert target["id"] == APF_ID
    assert target["name"] == "pf-s1"


def test_the_sibling_is_found_by_its_own_name(tmp_path):
    assert find_target(two_siblings(tmp_path).sub_dir, "pf-s1-recheck")["id"] == RECHECK_ID


def test_agent_id_matches(tmp_path):
    target = find_target(two_siblings(tmp_path).sub_dir, APF_ID)
    assert target["name"] == "pf-s1" and target["path"].endswith(APF + ".jsonl")


def test_an_id_prefix_is_not_a_match(tmp_path):
    assert find_target(two_siblings(tmp_path).sub_dir, "apf-s1") is None


def test_a_name_prefix_is_not_a_match(tmp_path):
    assert find_target(two_siblings(tmp_path).sub_dir, "pf-s") is None


def test_several_matches_the_latest_spawned_wins(tmp_path):
    s = Session(tmp_path)
    s.add_fixture(APF, mtime=NOW - 1000)
    s.add_agent("apf-s1-later", "pf-s1", fixture_lines(RECHECK), mtime=NOW - 5)
    assert find_target(s.sub_dir, "pf-s1")["id"] == "apf-s1-later"


def test_the_tiebreak_is_the_meta_mtime_not_the_transcript_mtime(tmp_path):
    # An older agent that was messaged recently has the newer transcript; the agent
    # spawned last has the newer meta file.
    s = Session(tmp_path)
    s.add_agent("first", "dup", fixture_lines(APF), mtime=NOW - 10, meta_mtime=NOW - 5000)
    s.add_agent("second", "dup", fixture_lines(RECHECK), mtime=NOW - 900, meta_mtime=NOW - 1000)
    assert find_target(s.sub_dir, "dup")["id"] == "second"


def test_no_match_and_a_missing_directory_give_none(tmp_path):
    s = two_siblings(tmp_path)
    assert find_target(s.sub_dir, "nobody") is None
    assert find_target(os.path.join(s.sub_dir, "absent"), "pf-s1") is None


def test_a_corrupt_meta_file_is_skipped(tmp_path):
    s = two_siblings(tmp_path)
    with open(os.path.join(s.sub_dir, "agent-broken.meta.json"), "w") as fh:
        fh.write("{not json")
    with open(os.path.join(s.sub_dir, "agent-broken.jsonl"), "w") as fh:
        fh.write("")
    assert find_target(s.sub_dir, "pf-s1")["id"] == APF_ID
