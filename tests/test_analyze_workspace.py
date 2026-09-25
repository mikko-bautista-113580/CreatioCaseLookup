import asyncio
import json
import sys
from pathlib import Path

import pytest

from creatio_case_lookup import analyze_workspace as aw
from creatio_case_lookup import claude_run, workspace
from creatio_case_lookup.claude_run import Launcher
from creatio_case_lookup.workspace import enumerate_workspaces, slug_for_paths

from ts_stdin_fixtures import INPUTS, TS_EXPECTED, py_opts

FAKE = str(Path(__file__).with_name("fake_claude_scripted.py"))


# ---------------------------------------------------------------------------
# stdin builders — byte-identical to the TS build
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("key", [k for k in INPUTS if k.startswith("ws_")])
def test_workspace_stdin_matches_ts(key):
    assert aw.build_workspace_stdin(py_opts(INPUTS[key])) == TS_EXPECTED[key]


@pytest.mark.parametrize("key", [k for k in INPUTS if k.startswith("case_")])
def test_case_stdin_matches_ts(key):
    assert aw.build_case_stdin(py_opts(INPUTS[key])) == TS_EXPECTED[key]


def test_sections_and_timeout(monkeypatch):
    assert aw.REPORT_SECTIONS[0] == "## Purpose" and len(aw.REPORT_SECTIONS) == 6
    assert aw.CASE_REPORT_SECTIONS == [*aw.REPORT_SECTIONS, "## Case relevance"]
    monkeypatch.setattr(aw, "read_env_file", lambda: {})
    monkeypatch.delenv("CREATIO_WORKSPACE_TIMEOUT_MS", raising=False)
    assert aw.workspace_timeout_ms() == 300_000
    for raw, want in [("5", 10_000), ("99999999", 900_000), ("123456abc", 123_456), ("nope", 300_000)]:
        monkeypatch.setenv("CREATIO_WORKSPACE_TIMEOUT_MS", raw)
        assert aw.workspace_timeout_ms() == want
    monkeypatch.delenv("CREATIO_WORKSPACE_TIMEOUT_MS")
    monkeypatch.setattr(aw, "read_env_file", lambda: {"CREATIO_WORKSPACE_TIMEOUT_MS": " 20000 "})
    assert aw.workspace_timeout_ms() == 20_000


def test_case_mode_requires_scope():
    with pytest.raises(ValueError, match="needs its case scope"):
        aw.analyze_workspace({"paths": ["C:\\x"], "mode": "case", "enumeration": INPUTS["ws_dir_single"]["enumeration"]},
                             on_chunk=print, on_done=print, on_error=print)


# ---------------------------------------------------------------------------
# Full runs against the scripted fake CLI
# ---------------------------------------------------------------------------
@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setattr(claude_run, "_LAUNCHER", Launcher(sys.executable, [FAKE], False))
    store = tmp_path / ".analysis"
    monkeypatch.setattr(workspace, "ANALYSIS_DIR", store)
    monkeypatch.setattr(workspace, "INDEX_PATH", store / "index.json")
    monkeypatch.setattr(workspace, "file_cap", lambda: 10)
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.cfm").write_text("<cfoutput>#GPA#</cfoutput>", encoding="utf-8")
    (ws / "b.cfm").write_text("x", encoding="utf-8")
    (ws / "inc").mkdir()
    ws2 = tmp_path / "ws2"
    ws2.mkdir()
    (ws2 / "c.cfm").write_text("y", encoding="utf-8")

    def script(**s):
        p = tmp_path / "script.json"
        s.setdefault("argv_out", str(tmp_path / "argv.json"))
        s.setdefault("stdin_out", str(tmp_path / "stdin.txt"))
        p.write_text(json.dumps(s), encoding="utf-8")
        monkeypatch.setenv("FAKE_SCRIPT", str(p))

    return {"tmp": tmp_path, "store": store, "ws": str(ws), "ws2": str(ws2), "script": script}


def run(opts):
    out = {"chunks": [], "tools": [], "done": None, "error": None, "partial": None, "calls": 0}

    async def main():
        def on_done(r):
            out["calls"] += 1
            out["done"] = r

        def on_error(err, partial):
            out["calls"] += 1
            out["error"], out["partial"] = err, partial

        h = aw.analyze_workspace(opts, on_chunk=out["chunks"].append, on_done=on_done,
                                 on_error=on_error, on_tool_use=out["tools"].append)
        await h.wait()

    asyncio.run(main())
    assert out["calls"] == 1
    return out


META_KEYS = ["version", "slug", "path", "paths", "mode", "target", "startedAt", "finishedAt", "durationMs",
             "model", "cap", "capExceeded", "proceededOverCap", "filesAnalyzed", "dirsPresent", "skipped",
             "truncated", "toolCalls", "usage", "status", "report"]


def test_directory_run_persists_report(env):
    paths = [env["ws"], env["ws2"]]
    en = enumerate_workspaces(paths)
    env["script"](chunks=["## Purpose\n", "Report templates."],
                  tools=[{"name": "Read", "input": {"file_path": "a.cfm"}}, {"name": "Glob", "input": {}}],
                  result={"result": "x", "total_cost_usd": 0.5, "usage": {"total_tokens": 99}, "duration_ms": 1234})
    out = run({"paths": paths, "mode": "directory", "enumeration": en, "model": "m-test"})

    assert out["error"] is None, out["error"]
    assert out["chunks"] == ["## Purpose\n", "Report templates."]
    assert out["tools"] == [{"name": "Read", "target": "a.cfm"}, {"name": "Glob"}]
    d = out["done"]
    assert d["costUsd"] == 0.5 and d["totalTokens"] == 99 and d["durationMs"] == 1234
    slug = slug_for_paths(paths)
    assert d["stored"] == {"report": f".analysis/{slug}/analysis.md", "meta": f".analysis/{slug}/analysis.json"}

    meta = json.loads((env["store"] / slug / "analysis.json").read_text(encoding="utf-8"))
    assert list(meta) == META_KEYS
    assert meta["report"] == f".analysis/{slug}/analysis.md"
    assert meta["paths"] == paths and meta["path"] == paths[0] and meta["target"] is None
    assert meta["status"] == "complete" and meta["truncated"] is False
    assert meta["usage"] == {"costUsd": 0.5, "totalTokens": 99}
    assert meta["toolCalls"] == [{"name": "Read", "target": "a.cfm"}, {"name": "Glob"}]
    assert [f["name"] for f in meta["filesAnalyzed"]] == ["a.cfm", "b.cfm", "c.cfm"]
    assert meta["dirsPresent"] == ["inc"]
    md = (env["store"] / slug / "analysis.md").read_text(encoding="utf-8")
    assert md.startswith("---\nworkspace: '") and md.endswith("## Purpose\nReport templates.\n")
    index = json.loads((env["store"] / "index.json").read_text(encoding="utf-8"))
    assert index["workspaces"][0]["directory"]["status"] == "complete"

    # The child got the read-only spec, the right cwd, and the file list on stdin.
    rec = json.loads((env["tmp"] / "argv.json").read_text(encoding="utf-8"))
    argv = rec["argv"]
    assert Path(rec["cwd"]) == Path(paths[0])
    assert argv[argv.index("-p") + 1] == aw.DIR_INSTRUCTION
    assert argv[argv.index("--append-system-prompt") + 1] == aw.WORKSPACE_SYSTEM_PROMPT
    assert argv[argv.index("--tools") + 1] == "Read,Glob,Grep"
    assert argv[argv.index("--allowed-tools") + 1] == "Read,Glob,Grep"
    assert argv[argv.index("--disallowed-tools") + 1] == ",".join(aw._DISALLOWED)
    assert "Read(**/.env)" in aw._DISALLOWED
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    assert argv[argv.index("--setting-sources") + 1] == "user"
    assert "--safe-mode" in argv
    assert argv[argv.index("--add-dir") + 1] == paths[1]
    assert argv[argv.index("--model") + 1] == "m-test"
    stdin = (env["tmp"] / "stdin.txt").read_text(encoding="utf-8")
    assert stdin == aw.build_workspace_stdin({"paths": paths, "mode": "directory", "enumeration": en})


def test_case_run_meta_and_location(env):
    paths = [env["ws"]]
    en = enumerate_workspaces(paths)
    scope = {
        "caseNumber": "SR00012345",
        "terms": ["gpa"],
        "files": [{"rel": "a.cfm", "folder": env["ws"], "score": 2, "reason": "content: gpa", "size": 26,
                   "mtime": "2026-01-01T00:00:00.000Z", "ext": ".cfm"}],
        "briefFetchedAt": "2026-09-01T00:00:00.000Z",
    }
    env["script"](chunks=["## Purpose\nx"], result={"result": "x"})
    out = run({"paths": paths, "mode": "case", "enumeration": en, "case_scope": scope, "model": "m"})
    slug = slug_for_paths(paths)
    assert out["done"]["stored"]["report"] == f".analysis/{slug}/cases/SR00012345.md"
    assert "costUsd" not in out["done"]
    meta = json.loads((env["store"] / slug / "cases" / "SR00012345.json").read_text(encoding="utf-8"))
    assert list(meta) == [k for k in META_KEYS if k != "durationMs"] + [
        "selection", "terms", "briefFetchedAt"]
    assert meta["target"] == "SR00012345" and meta["mode"] == "case"
    assert meta["filesAnalyzed"] == [{"name": "a.cfm", "folder": env["ws"], "size": 26,
                                      "mtime": "2026-01-01T00:00:00.000Z", "ext": ".cfm"}]
    assert meta["selection"] == [{"rel": "a.cfm", "folder": env["ws"], "score": 2, "reason": "content: gpa"}]
    assert meta["terms"] == ["gpa"] and meta["usage"] == {}
    rec = json.loads((env["tmp"] / "argv.json").read_text(encoding="utf-8"))
    assert rec["argv"][rec["argv"].index("-p") + 1] == aw.CASE_INSTRUCTION
    assert "--add-dir" not in rec["argv"]


def test_file_mode_is_truncated_when_folder_has_more_files(env):
    paths = [env["ws"]]
    env["script"](chunks=["r"], result={"result": "r"})
    out = run({"paths": paths, "mode": "file", "target": "a.cfm", "enumeration": enumerate_workspaces(paths)})
    m = out["done"]["meta"]
    assert m["target"] == "a.cfm" and [f["name"] for f in m["filesAnalyzed"]] == ["a.cfm"]
    assert m["truncated"] is True  # count > 1 in file mode
    assert out["done"]["stored"]["report"].endswith("/files/a-cfm.md")


def test_timeout_persists_partial(env):
    paths = [env["ws"]]
    env["script"](chunks=["## Purpose\npartial"], hang=True)
    out = run({"paths": paths, "mode": "directory", "enumeration": enumerate_workspaces(paths), "timeout_ms": 1500})
    assert "timed out" in out["error"].message
    p = out["partial"]
    assert p["meta"]["status"] == "timeout" and p["meta"]["truncated"] is True
    assert "durationMs" not in p["meta"]
    meta = json.loads((env["store"] / slug_for_paths(paths) / "analysis.json").read_text(encoding="utf-8"))
    assert meta["status"] == "timeout"


def test_stop_without_text_persists_nothing(env):
    paths = [env["ws"]]
    env["script"](hang=True)
    out = {}

    async def main():
        ev = asyncio.Event()
        h = aw.analyze_workspace({"paths": paths, "mode": "directory", "enumeration": enumerate_workspaces(paths),
                                  "cancel": ev},
                                 on_chunk=lambda c: None, on_done=lambda r: None,
                                 on_error=lambda e, p: out.update(err=e, partial=p))
        await asyncio.sleep(0.8)
        ev.set()
        await h.wait()

    asyncio.run(main())
    assert out["partial"] is None
    assert "aborted" in out["err"].message
    assert not (env["store"] / slug_for_paths(paths)).exists()


def test_model_resolution(monkeypatch):
    monkeypatch.setattr("creatio_case_lookup.env.read_env_file", lambda: {"CREATIO_APP_MODEL": "from-file"})
    monkeypatch.setenv("CREATIO_APP_MODEL", "from-env")
    assert aw._resolve_model({"model": "opt"}) == "opt"
    assert aw._resolve_model({}) == "from-env"
    monkeypatch.delenv("CREATIO_APP_MODEL")
    assert aw._resolve_model({}) == "from-file"
    monkeypatch.setattr("creatio_case_lookup.env.read_env_file", lambda: {})
    assert aw._resolve_model({}) == aw.DEFAULT_MODEL
