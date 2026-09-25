"""workspace_cli.py — argv parsing, each command's happy path and its error exits.

Everything runs against a tmp `.env` and a tmp `.analysis/` store; Creatio and
the Azure DevOps wiki are stubbed, so nothing touches the network.
"""

import io
import json
import os
import struct
import sys
import time
import zlib

import pytest

from creatio_case_lookup import ado_wiki, case_brief, case_scope, creatio_client, env, paths
from creatio_case_lookup import workspace as ws
from creatio_case_lookup import workspace_cli as cli
from creatio_case_lookup.ado_wiki import WikiUnavailable


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    envp = tmp_path / ".env"
    envp.write_text("", encoding="utf-8")
    monkeypatch.setattr(paths, "ENV_PATH", envp)
    monkeypatch.setattr(env, "ENV_PATH", envp)
    store = tmp_path / ".analysis"
    monkeypatch.setattr(ws, "ANALYSIS_DIR", store)
    monkeypatch.setattr(ws, "INDEX_PATH", store / "index.json")
    monkeypatch.setattr(case_brief, "CASES_DIR", store / "cases")
    monkeypatch.setattr(ado_wiki, "WIKI_DIR", store / "wiki")
    monkeypatch.setattr(ado_wiki, "TREE_PATH", store / "wiki" / "tree.json")
    monkeypatch.setattr(ado_wiki, "PAGES_DIR", store / "wiki" / "pages")
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "a.cfm").write_text("<cfoutput>report card gpa</cfoutput>\n", encoding="utf-8")
    (proj / "b.htm").write_text("<p>hello</p>\n", encoding="utf-8")
    # Backdate the files: an mtime a hair after the analysis timestamp (clock
    # vs filesystem granularity) would make a just-saved report look stale.
    old = time.time() - 60
    for f in proj.iterdir():
        os.utime(f, (old, old))
    return {"env": envp, "store": store, "proj": str(proj), "tmp": tmp_path}


def run(monkeypatch, capsys, *argv, stdin: bytes | None = None):
    """Call main() with argv; return (exit code, parsed stdout JSON or None, stderr)."""
    monkeypatch.setattr(sys, "argv", ["workspace_cli", *argv])
    if stdin is not None:
        monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(stdin), encoding="utf-8"))
    code = 0
    try:
        cli.main()
    except SystemExit as e:
        code = e.code
    o, err = capsys.readouterr()
    return code, (json.loads(o) if o.strip() else None), err


def _brief(number="SR00012345", **over):
    b = {
        "version": 1,
        "number": number,
        "id": "11111111-1111-1111-1111-111111111111",
        "subject": "Report card GPA wrong",
        "status": "Open",
        "description": "The report card a.cfm shows the wrong GPA.",
        "timeline": [],
        "attachments": [],
        "fetchedAt": ws.iso_now(),
        "caveats": [],
    }
    b.update(over)
    return b


def _png() -> bytes:
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\0\0\0\0")) + chunk(b"IEND", b"")


# ---------------------------------------------------------------------------
# parse_args
# ---------------------------------------------------------------------------


def test_parse_args_matches_ts_semantics():
    a = cli.parse_args(["x", "--path", "A", "--over-cap", "--path", "B", "--model", "m", "y", "--flag"])
    assert a == {"positional": ["x", "y"], "flags": {"over-cap": True, "model": "m", "flag": True}, "paths": ["A", "B"]}
    # A value-less --path (followed by another flag) is a boolean flag, not a path.
    assert cli.parse_args(["--path", "--no-wiki"]) == {"positional": [], "flags": {"path": True, "no-wiki": True}, "paths": []}
    # A boolean-looking flag still swallows a following non-flag token.
    assert cli.parse_args(["--no-wiki", "SR1"])["flags"] == {"no-wiki": "SR1"}


# ---------------------------------------------------------------------------
# usage
# ---------------------------------------------------------------------------


def test_unknown_and_missing_command_print_usage(sandbox, monkeypatch, capsys):
    for argv in ([], ["bogus"]):
        code, o, err = run(monkeypatch, capsys, *argv)
        assert code == 1 and o is None
        assert err.startswith("Usage:\n  python -m creatio_case_lookup.workspace_cli path")


# ---------------------------------------------------------------------------
# path
# ---------------------------------------------------------------------------


def test_path_reports_and_sets(sandbox, monkeypatch, capsys):
    code, o, _ = run(monkeypatch, capsys, "path")
    assert code == 0 and o == {"paths": [], "set": False, "maxPaths": 3}

    code, o, _ = run(monkeypatch, capsys, "path", sandbox["proj"], sandbox["proj"].upper())
    assert code == 0
    assert o == {"paths": [sandbox["proj"]], "set": True, "saved": True, "maxPaths": 3}  # case-insensitive dedupe
    assert ws.get_workspace_paths() == [sandbox["proj"]]

    code, o, _ = run(monkeypatch, capsys, "path")
    assert o == {"paths": [sandbox["proj"]], "set": True, "maxPaths": 3}


def test_path_errors(sandbox, monkeypatch, capsys):
    missing = str(sandbox["tmp"] / "nope")
    code, _, err = run(monkeypatch, capsys, "path", missing)
    assert code == 2 and err == f"{missing}: That folder doesn't exist.\n"
    code, _, err = run(monkeypatch, capsys, "path", "a", "b", "c", "d")
    assert code == 1 and err == "A workspace can have at most 3 folders; got 4.\n"
    assert ws.get_workspace_paths() == []


# ---------------------------------------------------------------------------
# scan
# ---------------------------------------------------------------------------


def test_scan(sandbox, monkeypatch, capsys):
    code, o, _ = run(monkeypatch, capsys, "scan", sandbox["proj"])
    assert code == 0
    assert o["paths"] == [sandbox["proj"]] and o["count"] == 2 and o["stored"] is None
    assert o["folders"][0]["files"] == ["a.cfm", "b.htm"]
    assert o["slug"] == ws.slug_for_paths([sandbox["proj"]])


def test_scan_without_workspace_is_exit_2(sandbox, monkeypatch, capsys):
    code, _, err = run(monkeypatch, capsys, "scan")
    assert code == 2
    assert err.startswith("No workspace folder set.")
    assert 'python -m creatio_case_lookup.workspace_cli path "C:\\path\\to\\project"' in err


# ---------------------------------------------------------------------------
# save + load
# ---------------------------------------------------------------------------


def test_save_directory_then_load_and_scan(sandbox, monkeypatch, capsys):
    p = sandbox["proj"]
    code, o, _ = run(monkeypatch, capsys, "save", "directory", "--path", p, "--model", "m1", stdin="# Report\n\nbody ✓\n".encode())
    assert code == 0
    assert o["saved"] is True and o["mode"] == "directory" and o["target"] is None and o["paths"] == [p]
    assert o["report"].endswith("analysis.md") and o["meta"].endswith("analysis.json")

    code, o, _ = run(monkeypatch, capsys, "load", p)
    assert code == 0
    assert o["markdown"] == "# Report\n\nbody ✓\n"
    assert o["meta"]["model"] == "m1" and o["meta"]["proceededOverCap"] is False
    assert len(o["meta"]["filesAnalyzed"]) == 2
    assert o["stale"] is False

    code, o, _ = run(monkeypatch, capsys, "scan", p)
    assert o["stored"]["filesAnalyzed"] == 2 and o["stored"]["status"] == "complete"


def test_save_file_mode(sandbox, monkeypatch, capsys):
    p = sandbox["proj"]
    code, o, _ = run(monkeypatch, capsys, "save", "file", "a.cfm", "--path", p, "--over-cap", stdin=b"x")
    assert code == 0 and o["mode"] == "file" and o["target"] == "a.cfm"
    code, o, _ = run(monkeypatch, capsys, "load", p, "--mode", "file", "--file", "a.cfm")
    assert code == 0
    assert o["meta"]["truncated"] is True and o["meta"]["proceededOverCap"] is True
    assert [f["name"] for f in o["meta"]["filesAnalyzed"]] == ["a.cfm"]
    assert "model" not in o["meta"]
    # Directory load then points at the stored single-file analysis.
    code, _, err = run(monkeypatch, capsys, "load", p)
    assert code == 4
    assert err == (
        f"No stored directory analysis in {p}. Stored single-file analyses: a.cfm.\n"
        "Run an analysis first (the Workspace tab, or the workspace-analysis skill).\n"
    )


def test_save_errors(sandbox, monkeypatch, capsys):
    p = sandbox["proj"]
    code, _, err = run(monkeypatch, capsys, "save")
    assert code == 1 and err.startswith("Usage: python -m creatio_case_lookup.workspace_cli save")
    code, _, err = run(monkeypatch, capsys, "save", "case", "--path", p)
    assert code == 1 and err == 'Mode must be "directory" or "file", got "case".\n'
    code, _, err = run(monkeypatch, capsys, "save", "directory", "--path", p, stdin=b"  \n")
    assert code == 1 and err.startswith("Nothing on stdin")
    code, _, err = run(monkeypatch, capsys, "save", "file", "--path", p, stdin=b"x")
    assert code == 1 and err == "Mode `file` requires the target file name as the second argument.\n"
    code, _, err = run(monkeypatch, capsys, "save", "file", "zzz.cfm", "--path", p, stdin=b"x")
    assert code == 1 and err == f'"zzz.cfm" is not one of the top-level text files in {p}.\nAvailable: a.cfm, b.htm\n'
    code, _, _ = run(monkeypatch, capsys, "save", "directory", stdin=b"x")
    assert code == 2  # no workspace configured


def test_load_errors(sandbox, monkeypatch, capsys):
    p = sandbox["proj"]
    code, _, err = run(monkeypatch, capsys, "load", p)
    assert code == 4 and err.startswith(f"No stored directory analysis in {p}.\n")
    code, _, err = run(monkeypatch, capsys, "load", p, "--mode", "bogus")
    assert code == 1 and err == '--mode must be "directory", "file" or "case", got "bogus".\n'
    code, _, err = run(monkeypatch, capsys, "load", p, "--mode", "file")
    assert code == 1 and err == "--mode file requires --file <name>.\n"
    code, _, err = run(monkeypatch, capsys, "load", p, "--mode", "case")
    assert code == 1 and err == "--mode case needs --case <SR…> or a bound case.\n"
    code, _, err = run(monkeypatch, capsys, "load", p, "--case", "SR00012345")
    assert code == 4 and err.startswith(f"No stored case analysis for SR00012345 in {p}.")
    code, _, err = run(monkeypatch, capsys, "load", p, "--case", "nope")
    assert code == 2 and "doesn't look like a case number" in err


# ---------------------------------------------------------------------------
# case
# ---------------------------------------------------------------------------


def test_case_unbound_then_bind(sandbox, monkeypatch, capsys):
    code, _, err = run(monkeypatch, capsys, "case")
    assert code == 4 and err.startswith("No case is bound.")

    code, o, _ = run(monkeypatch, capsys, "case", "sr00012345")
    assert code == 0
    assert o["saved"] is True and o["number"] == "SR00012345" and o["brief"] is None
    assert o["ageHours"] is None and o["stale"] is None and o["note"].startswith("Bound. No stored brief yet")
    assert case_brief.get_bound_case() == "SR00012345"

    case_brief.save_brief(_brief())
    code, o, _ = run(monkeypatch, capsys, "case")
    assert code == 0
    assert o["number"] == "SR00012345" and o["brief"]["subject"] == "Report card GPA wrong"
    assert o["ageHours"] == 0 and o["stale"] is False

    code, o, _ = run(monkeypatch, capsys, "case", "SR00012345")
    assert o["note"] == "Bound. A stored brief already exists for this case."


def test_case_bad_number_and_unusable_age(sandbox, monkeypatch, capsys):
    code, _, err = run(monkeypatch, capsys, "case", "12345")
    assert code == 2 and "doesn't look like a case number" in err
    case_brief.save_brief(_brief(fetchedAt="garbage"))
    case_brief.set_bound_case("SR00012345")
    code, o, _ = run(monkeypatch, capsys, "case")
    assert code == 0 and o["ageHours"] is None and o["stale"] is True  # Infinity → null, like JSON.stringify


# ---------------------------------------------------------------------------
# attachment
# ---------------------------------------------------------------------------


def test_attachment_saves_and_refuses_overwrite(sandbox, monkeypatch, capsys):
    p = sandbox["proj"]
    calls = []

    async def fake_download(entity, fid):
        calls.append((entity, fid))
        return {"buffer": _png(), "contentType": "image/png"}

    monkeypatch.setattr(creatio_client, "download_file", fake_download)
    code, o, _ = run(monkeypatch, capsys, "attachment", "fid-1", "logo.png", "--path", p)
    assert code == 0 and calls == [("CaseFile", "fid-1")]
    assert o["saved"] is True and o["name"] == "logo.png" and o["overwrote"] is False and o["backup"] is None
    assert o["bytes"] == len(_png())

    code, _, err = run(monkeypatch, capsys, "attachment", "fid-1", "logo.png", "--path", p)
    assert code == 2 and "already exists" in err

    code, o, _ = run(monkeypatch, capsys, "attachment", "fid-1", "logo.png", "--path", p, "--overwrite")
    assert code == 0 and o["overwrote"] is True and o["backup"]

    code, _, err = run(monkeypatch, capsys, "attachment", "fid-1", "logo.jpg", "--path", p)
    assert code == 2 and "PNG image" in err


def test_attachment_errors(sandbox, monkeypatch, capsys):
    code, _, err = run(monkeypatch, capsys, "attachment", "fid-1")
    assert code == 1 and err.startswith("Usage: python -m creatio_case_lookup.workspace_cli attachment")
    code, _, err = run(monkeypatch, capsys, "attachment", "fid-1", "logo.png")
    assert code == 2 and err.startswith("No workspace folder configured.")
    code, _, err = run(monkeypatch, capsys, "attachment", "fid-1", "logo.png", "--path", "relative")
    assert code == 2 and ("drive letter" in err or "full path" in err)

    async def boom(entity, fid):
        raise RuntimeError("Creatio said no")

    monkeypatch.setattr(creatio_client, "download_file", boom)
    code, _, err = run(monkeypatch, capsys, "attachment", "fid-1", "logo.png", "--path", sandbox["proj"])
    assert code == 1 and err == "Creatio said no\n"


# ---------------------------------------------------------------------------
# scope
# ---------------------------------------------------------------------------


def test_scope_no_wiki(sandbox, monkeypatch, capsys):
    case_brief.save_brief(_brief())
    code, o, _ = run(monkeypatch, capsys, "scope", "SR00012345", "--path", sandbox["proj"], "--no-wiki")
    assert code == 0
    assert o["caseNumber"] == "SR00012345"
    assert o["wikiSkipped"] == "Team wiki lookup was not requested." and o["wiki"] == []
    assert any(t["term"] == "a.cfm" or t["term"] == "gpa" for t in o["terms"])
    assert o["files"] and o["files"][0]["rel"] == "a.cfm"


def test_scope_wiki_unavailable_is_skipped_not_fatal(sandbox, monkeypatch, capsys):
    case_brief.save_brief(_brief())
    case_brief.set_bound_case("SR00012345")
    ws.set_workspace_paths([sandbox["proj"]])

    async def no_wiki(refresh=False):
        raise WikiUnavailable("Azure CLI isn't logged in.", "auth")

    monkeypatch.setattr(case_scope, "get_wiki_tree", no_wiki)
    code, o, _ = run(monkeypatch, capsys, "scope")
    assert code == 0 and o["wikiSkipped"] == "Azure CLI isn't logged in."


def test_scope_errors(sandbox, monkeypatch, capsys):
    code, _, err = run(monkeypatch, capsys, "scope")
    assert code == 4 and err == "No case is bound. Pass one: python -m creatio_case_lookup.workspace_cli scope SR00031980\n"
    code, _, err = run(monkeypatch, capsys, "scope", "SR00099999")
    assert code == 4 and err.startswith("No stored brief for SR00099999.")
    code, _, err = run(monkeypatch, capsys, "scope", "SRxx")
    assert code == 2
    case_brief.save_brief(_brief())
    code, _, err = run(monkeypatch, capsys, "scope", "SR00012345")
    assert code == 2 and err.startswith("No workspace folder set.")


# ---------------------------------------------------------------------------
# wiki
# ---------------------------------------------------------------------------


def test_wiki_search_and_page(sandbox, monkeypatch, capsys):
    tree = [
        {"path": "/Reports/Report Card GPA", "section": False},
        {"path": "/Reports/Transcripts", "section": False},
        {"path": "/Other", "section": True},
    ]

    async def fake_tree(refresh=False):
        return tree

    async def fake_page(path, refresh=False):
        return {"path": path, "url": "https://x/" + path, "content": "hello"}

    monkeypatch.setattr(cli, "get_wiki_tree", fake_tree)
    monkeypatch.setattr(cli, "get_wiki_page", fake_page)

    code, o, _ = run(monkeypatch, capsys, "wiki", "search", "Report", "Card!", "GPA")
    assert code == 0 and o["pages"] == 3
    assert o["matches"] and o["matches"][0]["path"] == "/Reports/Report Card GPA"

    code, o, _ = run(monkeypatch, capsys, "wiki", "page", "/Reports/Report", "Card", "GPA")
    assert code == 0 and o["path"] == "/Reports/Report Card GPA" and o["content"] == "hello"


def test_wiki_errors(sandbox, monkeypatch, capsys):
    for argv in (["wiki"], ["wiki", "search"], ["wiki", "page"], ["wiki", "nope", "x"]):
        code, _, err = run(monkeypatch, capsys, *argv)
        assert code == 1 and err == "Usage: python -m creatio_case_lookup.workspace_cli wiki search <terms...> | python -m creatio_case_lookup.workspace_cli wiki page <path>\n"

    async def unavailable(*a, **k):
        raise WikiUnavailable("The team wiki returned HTTP 404.", "http")

    monkeypatch.setattr(cli, "get_wiki_page", unavailable)
    code, _, err = run(monkeypatch, capsys, "wiki", "page", "/x")
    assert code == 4 and err == "The team wiki returned HTTP 404.\n"

    async def crash(*a, **k):
        raise ValueError("boom")

    monkeypatch.setattr(cli, "get_wiki_tree", crash)
    code, _, err = run(monkeypatch, capsys, "wiki", "search", "x")
    assert code == 1 and err == "boom\n"
