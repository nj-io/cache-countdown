import json
import os
import sys

import cold_wake_guard
from cold_wake_guard import managed_settings_paths, read_cache_ttl_setting, resolve_config


def home_with_settings(tmp_path, settings):
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "settings.json").write_text(settings if isinstance(settings, str) else json.dumps(settings))
    return {"HOME": str(tmp_path)}


def test_defaults(tmp_path):
    cfg = resolve_config({"HOME": str(tmp_path)})
    assert (cfg["ttl_seconds"], cfg["min_tokens"], cfg["log_events"]) == (300, 50_000, False)
    assert cfg["log_path"] == str(tmp_path / ".claude" / "logs" / "cache" / "guard.jsonl")


def test_plugin_options_come_from_claude_plugin_option_variables(tmp_path):
    env = {
        "HOME": str(tmp_path),
        "CLAUDE_PLUGIN_OPTION_TTL_SECONDS": "60",
        "CLAUDE_PLUGIN_OPTION_MIN_TOKENS": "1000",
        "CLAUDE_PLUGIN_OPTION_LOG_EVENTS": "true",
    }
    cfg = resolve_config(env)
    assert (cfg["ttl_seconds"], cfg["min_tokens"], cfg["log_events"]) == (60, 1000, True)


def test_log_events_false_and_junk_values_stay_off(tmp_path):
    for value in ("false", "0", "", "maybe"):
        env = {"HOME": str(tmp_path), "CLAUDE_PLUGIN_OPTION_LOG_EVENTS": value}
        assert resolve_config(env)["log_events"] is False


def test_invalid_or_empty_numbers_fall_back_to_the_defaults(tmp_path):
    for value in ("", "abc", "-5"):
        env = {"HOME": str(tmp_path), "CLAUDE_PLUGIN_OPTION_TTL_SECONDS": value, "CLAUDE_PLUGIN_OPTION_MIN_TOKENS": value}
        cfg = resolve_config(env)
        assert (cfg["ttl_seconds"], cfg["min_tokens"]) == (300, 50_000)


def test_a_zero_ttl_falls_back_but_a_zero_min_tokens_is_kept(tmp_path):
    env = {"HOME": str(tmp_path), "CLAUDE_PLUGIN_OPTION_TTL_SECONDS": "0", "CLAUDE_PLUGIN_OPTION_MIN_TOKENS": "0"}
    cfg = resolve_config(env)
    assert (cfg["ttl_seconds"], cfg["min_tokens"]) == (300, 0)


def test_one_hour_cache_setting_raises_the_ttl(tmp_path):
    env = home_with_settings(tmp_path, {"subagentPromptCacheTtl": "1h"})
    assert resolve_config(env)["ttl_seconds"] == 3600


def test_an_explicit_ttl_seconds_beats_the_one_hour_setting(tmp_path):
    env = home_with_settings(tmp_path, {"subagentPromptCacheTtl": "1h"})
    env["CLAUDE_PLUGIN_OPTION_TTL_SECONDS"] = "120"
    assert resolve_config(env)["ttl_seconds"] == 120


def test_other_setting_values_and_unreadable_settings_keep_300(tmp_path):
    assert resolve_config(home_with_settings(tmp_path, {"subagentPromptCacheTtl": "5m"}))["ttl_seconds"] == 300
    assert read_cache_ttl_setting({"HOME": str(tmp_path / "nowhere")}) is None
    broken = tmp_path / "broken"
    broken.mkdir()
    assert resolve_config(home_with_settings(broken, "{not json"))["ttl_seconds"] == 300


def test_claude_config_dir_is_honoured_for_settings_and_log(tmp_path):
    (tmp_path / "cfg").mkdir()
    (tmp_path / "cfg" / "settings.json").write_text('{"subagentPromptCacheTtl": "1h"}')
    cfg = resolve_config({"HOME": str(tmp_path / "other"), "CLAUDE_CONFIG_DIR": str(tmp_path / "cfg")})
    assert cfg["ttl_seconds"] == 3600
    assert cfg["log_path"] == str(tmp_path / "cfg" / "logs" / "cache" / "guard.jsonl")


def write_settings(directory, name, value):
    (directory / ".claude").mkdir(exist_ok=True)
    (directory / ".claude" / name).write_text(json.dumps({"subagentPromptCacheTtl": value}))


def test_project_settings_are_read_from_the_hook_cwd(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    write_settings(project, "settings.json", "1h")
    env = {"HOME": str(tmp_path / "home")}
    assert resolve_config(env, str(project))["ttl_seconds"] == 3600
    assert resolve_config(env)["ttl_seconds"] == 300  # no cwd, no project settings


def test_local_settings_beat_project_and_user_settings(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    env = home_with_settings(tmp_path, {"subagentPromptCacheTtl": "1h"})
    write_settings(project, "settings.json", "5m")
    assert resolve_config(env, str(project))["ttl_seconds"] == 300  # project beats user
    write_settings(project, "settings.local.json", "1h")
    assert resolve_config(env, str(project))["ttl_seconds"] == 3600  # local beats project


def test_project_settings_beat_user_settings(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    env = home_with_settings(tmp_path, {"subagentPromptCacheTtl": "5m"})
    write_settings(project, "settings.json", "1h")
    assert resolve_config(env, str(project))["ttl_seconds"] == 3600


def test_an_explicit_ttl_seconds_beats_every_settings_source(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    env = home_with_settings(tmp_path, {"subagentPromptCacheTtl": "1h"})
    write_settings(project, "settings.local.json", "1h")
    env["CLAUDE_PLUGIN_OPTION_TTL_SECONDS"] = "90"
    assert resolve_config(env, str(project))["ttl_seconds"] == 90


# --- managed settings --------------------------------------------------------


def write_managed(tmp_path, value):
    path = tmp_path / "managed-settings.json"
    path.write_text(json.dumps({"subagentPromptCacheTtl": value}))
    return [str(path)]


def test_managed_settings_beat_user_settings(tmp_path):
    env = home_with_settings(tmp_path, {"subagentPromptCacheTtl": "5m"})
    assert resolve_config(env, managed_paths=write_managed(tmp_path, "1h"))["ttl_seconds"] == 3600


def test_managed_settings_beat_project_and_local_settings(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    write_settings(project, "settings.local.json", "1h")
    env = {"HOME": str(tmp_path / "home")}
    assert resolve_config(env, str(project))["ttl_seconds"] == 3600
    assert resolve_config(env, str(project), write_managed(tmp_path, "5m"))["ttl_seconds"] == 300


def test_an_explicit_ttl_seconds_beats_managed_settings(tmp_path):
    env = {"HOME": str(tmp_path), "CLAUDE_PLUGIN_OPTION_TTL_SECONDS": "90"}
    assert resolve_config(env, managed_paths=write_managed(tmp_path, "1h"))["ttl_seconds"] == 90


def test_a_missing_managed_file_changes_nothing(tmp_path):
    env = home_with_settings(tmp_path, {"subagentPromptCacheTtl": "1h"})
    assert resolve_config(env, managed_paths=[str(tmp_path / "absent.json")])["ttl_seconds"] == 3600


def test_the_default_managed_paths_are_read(tmp_path, monkeypatch):
    (tmp_path / "managed.json").write_text('{"subagentPromptCacheTtl": "1h"}')
    monkeypatch.setattr(cold_wake_guard, "managed_settings_paths", lambda env=None: [str(tmp_path / "managed.json")])
    assert resolve_config({"HOME": str(tmp_path)})["ttl_seconds"] == 3600


def test_managed_settings_paths_per_platform(monkeypatch):
    monkeypatch.undo()  # the suite-wide stub is gone for this test
    monkeypatch.setattr(sys, "platform", "darwin")
    assert managed_settings_paths({}) == ["/Library/Application Support/ClaudeCode/managed-settings.json"]
    monkeypatch.setattr(sys, "platform", "linux")
    assert managed_settings_paths({}) == ["/etc/claude-code/managed-settings.json"]
    monkeypatch.setattr(sys, "platform", "win32")
    paths = managed_settings_paths({"PROGRAMDATA": "D:/PD"})
    assert paths == [os.path.join("D:/PD", "ClaudeCode", "managed-settings.json")]
