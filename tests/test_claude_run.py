import asyncio
import json
import sys
from pathlib import Path

import pytest

from creatio_case_lookup import claude_run
from creatio_case_lookup.claude_run import (
    Launcher,
    RunSpec,
    Tools,
    build_args,
    run_claude,
    tool_target,
    win_quote,
)

FAKE = str(Path(__file__).with_name("fake_claude.py"))


# ---------------------------------------------------------------------------
# argv
# ---------------------------------------------------------------------------
def test_build_args_full_spec_matches_ts_order():
    spec = RunSpec(
        instruction='Do "the" thing',
        system_prompt="SYS",
        stdin="ignored",
        cwd={"dir": "C:/repo"},
        tools=Tools(set=["Read", "Edit"], allowed=["Read"], disallowed=["Read(.env)", "Bash"]),
        setting_sources=["project", "local"],
        safe_mode=True,
        add_dirs=["C:/a", "C:/b"],
        permission_mode="acceptEdits",
        model="claude-opus-5-5",
    )
    assert build_args(spec) == [
        "-p", 'Do "the" thing',
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--permission-mode", "acceptEdits",
        "--append-system-prompt", "SYS",
        "--no-session-persistence",
        "--tools", "Read,Edit",
        "--allowed-tools", "Read",
        "--disallowed-tools", "Read(.env),Bash",
        "--setting-sources", "project,local",
        "--safe-mode",
        "--add-dir", "C:/a",
        "--add-dir", "C:/b",
        "--model", "claude-opus-5-5",
    ]


def test_build_args_minimal_and_json_and_empty_setting_sources():
    spec = RunSpec(instruction="I", system_prompt="S", stdin="", output_format="json",
                   setting_sources=[], tools={"set": [], "allowed": None})
    assert build_args(spec) == [
        "-p", "I", "--output-format", "json", "--verbose", "--strict-mcp-config",
        "--permission-mode", "dontAsk", "--append-system-prompt", "S",
        "--no-session-persistence", "--setting-sources", "",
    ]
    # setting_sources=None omits the flag entirely.
    assert "--setting-sources" not in build_args(RunSpec("I", "S", ""))


def test_win_quote_and_tool_target():
    assert win_quote('a "b" c') == '"a ""b"" c"'
    assert tool_target({"path": "", "pattern": "*.ts"}) == "*.ts"
    assert tool_target({"file_path": "x", "url": "u"}) == "x"
    assert tool_target("nope") is None
    assert tool_target({}) is None
    assert tool_target(None) is None


# ---------------------------------------------------------------------------
# Running against the fake CLI
# ---------------------------------------------------------------------------
@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(claude_run, "_LAUNCHER", Launcher(sys.executable, [FAKE], False))

    def set_mode(mode):
        monkeypatch.setenv("FAKE_CLAUDE_MODE", mode)

    return set_mode


def run(spec, kill_after=None):
    out = {"chunks": [], "tools": [], "done": None, "error": None, "calls": 0}

    async def main():
        def on_done(meta):
            out["calls"] += 1
            out["done"] = meta

        def on_error(err):
            out["calls"] += 1
            out["error"] = err

        h = run_claude(spec, out["chunks"].append, on_done, on_error, out["tools"].append)
        if kill_after is not None:
            await asyncio.sleep(kill_after)
            h.kill()
            h.kill()  # idempotent
        await h.wait()
        h.kill()  # safe after finish

    asyncio.run(main())
    assert out["calls"] == 1, "exactly one of on_done/on_error must fire"
    return out


def spec(**kw):
    kw.setdefault("stdin", "")
    return RunSpec(instruction="I", system_prompt="S", cwd="isolated", setting_sources=[], **kw)


def test_stream_parsing(fake):
    fake("ok")
    out = run(spec())
    assert out["error"] is None
    assert out["chunks"] == ["Hello ", "wörld"]
    assert out["tools"] == [{"name": "Read", "input": {"file_path": "a.txt"}}]
    assert out["done"] == {"costUsd": 0.0123, "totalTokens": 15, "durationMs": 42,
                           "resultText": "Hello wörld"}


def test_stdin_reaches_child(fake):
    fake("echo")
    out = run(spec(stdin="QUESTION: ünïcode?\n\nctx"))
    assert out["chunks"] == ["STDIN:QUESTION: ünïcode?\n\nctx"]
    assert out["done"]["resultText"] == "done"


def test_empty_stdin_still_closed(fake):
    fake("echo")
    out = run(spec(stdin=""))
    assert out["chunks"] == ["STDIN:"]


def test_spec_env_reaches_child_on_top_of_ours(fake, monkeypatch):
    fake("entrypoint")
    monkeypatch.delenv("CLAUDE_CODE_ENTRYPOINT", raising=False)
    assert run(spec(stdin=""))["chunks"] == ["<unset>"]
    # Extra vars are added; the app's own (FAKE_CLAUDE_MODE here) still arrive.
    s = RunSpec(instruction="i", system_prompt="S", stdin="", env={"CLAUDE_CODE_ENTRYPOINT": "claude-desktop"})
    assert run(s)["chunks"] == ["claude-desktop"]


def test_argv_reaches_child_intact(fake):
    fake("argv")
    s = RunSpec(instruction='say "hi" --tools x', system_prompt="S", stdin="")
    out = run(s)
    assert json.loads(out["chunks"][0]) == build_args(s)


def test_app_settings_reach_the_child_filtered(fake, monkeypatch, tmp_path):
    from creatio_case_lookup import analyze, claude_run

    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "model": "claude-opus-5-5", "effortLevel": "medium", "outputStyle": "Concise",
        "hooks": {"PreToolUse": [{"command": "evil"}]}, "permissions": {"allow": ["Bash"]},
    }), encoding="utf-8")
    monkeypatch.setattr(claude_run, "APP_SETTINGS_PATH", settings)
    assert claude_run.app_settings() == {"model": "claude-opus-5-5", "effortLevel": "medium", "outputStyle": "Concise"}

    fake("argv")
    argv = json.loads(run(RunSpec(instruction="i", system_prompt="S", stdin=""))["chunks"][0])
    passed = Path(argv[argv.index("--settings") + 1])
    # Only the whitelisted keys ride along — never hooks or permissions.
    assert json.loads(passed.read_text(encoding="utf-8")) == claude_run.app_settings()
    # "" opts a run out.
    argv = json.loads(run(RunSpec(instruction="i", system_prompt="S", stdin="", settings_file=""))["chunks"][0])
    assert "--settings" not in argv

    monkeypatch.delenv("CREATIO_APP_MODEL", raising=False)
    monkeypatch.setattr("creatio_case_lookup.env.read_env_file", lambda: {})
    assert analyze.default_model() == "claude-opus-5-5"
    monkeypatch.setattr("creatio_case_lookup.env.read_env_file", lambda: {"CREATIO_APP_MODEL": "claude-sonnet-5"})
    assert analyze.default_model() == "claude-opus-5-5"  # settings.json wins over .env
    settings.write_text("{not json", encoding="utf-8")
    assert claude_run.app_settings() == {} and claude_run.app_settings_file() is None


def test_result_only_emitted_as_chunk_and_flushed(fake):
    fake("result_only")
    out = run(spec())
    assert out["chunks"] == ["whole answer"]
    assert out["done"] == {"totalTokens": 7, "resultText": "whole answer"}


def test_json_output_format_fallback(fake):
    fake("json")
    out = run(spec(output_format="json"))
    assert out["chunks"] == ["json answer"]
    assert out["done"] == {"durationMs": 5, "resultText": "json answer"}


def test_not_logged_in(fake):
    fake("not_logged_in")
    out = run(spec())
    assert out["chunks"] == []
    assert out["error"].kind == "not_logged_in"
    assert "not logged in" in str(out["error"])


def test_rate_limit_hint(fake):
    fake("rate_limit")
    out = run(spec())
    e = out["error"]
    assert e.kind == "failed"
    assert e.message.startswith("Run failed (exit 1): API Error: 429 Too Many Requests")
    assert e.message.endswith(" — Claude looks rate-limited/overloaded; wait a moment and retry.")


def test_silent_failure(fake):
    fake("silent_fail")
    out = run(spec())
    assert out["error"].message == "Run failed (exit 3): no output from Claude"


def test_timeout_kills(fake):
    fake("hang")
    out = run(spec(timeout_ms=1500))
    assert out["error"].message == "The run timed out after 2s."
    assert out["error"].kind == "failed"


def test_kill_aborts(fake):
    fake("hang")
    out = run(spec(), kill_after=1.0)
    assert out["error"].message == "Failed to run Claude: The operation was aborted"


def test_cancel_event_aborts(fake):
    fake("hang")
    out = {"err": None}

    async def main():
        ev = asyncio.Event()
        h = run_claude(spec(cancel=ev), lambda c: None, lambda m: None,
                       lambda e: out.__setitem__("err", e))
        await asyncio.sleep(1.0)
        ev.set()
        await h.wait()

    asyncio.run(main())
    assert out["err"].message == "Failed to run Claude: The operation was aborted"


def test_not_installed_when_no_launcher(monkeypatch):
    monkeypatch.setattr(claude_run, "_LAUNCHER", None)
    errs = []
    h = run_claude(spec(), lambda c: None, lambda m: None, errs.append)
    assert errs[0].kind == "not_installed"
    assert not claude_run.claude_available()
    asyncio.run(h.wait())


def test_missing_executable_is_not_installed(monkeypatch):
    monkeypatch.setattr(claude_run, "_LAUNCHER",
                        Launcher(str(Path(FAKE).with_name("no_such_claude.exe")), [], False))
    out = run(spec())
    assert out["error"].kind == "not_installed"
    assert out["error"].message == "The Claude CLI could not be launched."


def test_launcher_cache_includes_none(monkeypatch):
    calls = []

    class R:
        stdout = ""

    def fake_run(*a, **k):
        calls.append(a)
        return R()

    claude_run._reset_launcher_cache()
    monkeypatch.setattr(claude_run.subprocess, "run", fake_run)
    try:
        assert claude_run._resolve_claude_launcher() is None
        assert claude_run._resolve_claude_launcher() is None
        assert len(calls) == 1
    finally:
        claude_run._reset_launcher_cache()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows launcher resolution")
def test_windows_launcher_resolution_order(monkeypatch, tmp_path):
    shim = tmp_path / "claude.cmd"
    shim.write_text("@echo off", encoding="utf-8")
    pkg = tmp_path / "node_modules" / "@anthropic-ai" / "claude-code"
    exe = pkg / "bin" / "claude.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")

    class R:
        stdout = f"{tmp_path / 'claude'}\r\n{shim}\r\n"

    claude_run._reset_launcher_cache()
    monkeypatch.setattr(claude_run.subprocess, "run", lambda *a, **k: R())
    monkeypatch.setattr(claude_run.shutil, "which", lambda n: "C:/node/node.exe")
    try:
        assert claude_run._resolve_claude_launcher() == Launcher(str(exe), [], False)

        claude_run._reset_launcher_cache()
        exe.unlink()
        cli = pkg / "cli.js"
        cli.write_text("", encoding="utf-8")
        assert claude_run._resolve_claude_launcher() == Launcher("C:/node/node.exe", [str(cli)], False)

        claude_run._reset_launcher_cache()
        cli.unlink()
        assert claude_run._resolve_claude_launcher() == Launcher(str(shim), [], True)

        # A real .exe on PATH wins over everything.
        claude_run._reset_launcher_cache()
        R.stdout = f"{shim}\r\nC:\\bin\\claude.exe\r\n"
        assert claude_run._resolve_claude_launcher() == Launcher("C:\\bin\\claude.exe", [], False)
    finally:
        claude_run._reset_launcher_cache()
