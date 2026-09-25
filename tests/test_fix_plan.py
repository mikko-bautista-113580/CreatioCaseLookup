import asyncio
import json
import os
import re
import sys
from pathlib import Path

import pytest

from creatio_case_lookup import claude_run, fix_plan, workspace
from creatio_case_lookup.case_files import with_case_files
from creatio_case_lookup.claude_run import Launcher
from creatio_case_lookup.fix_plan import (
    FixPlanError,
    apply_plan,
    build_fix_stdin,
    check_edit,
    dominant_eol,
    extract_plan_json,
    latest_plan,
    load_plan,
    recheck_plan,
    save_plan,
    to_eol,
    validate_plan,
)
from creatio_case_lookup.workspace import enumerate_workspaces

from ts_stdin_fixtures import INPUTS, TS_EXPECTED, py_opts

FAKE = str(Path(__file__).with_name("fake_claude_scripted.py"))


# ---------------------------------------------------------------------------
# Ported from src/fixPlan.test.ts
# ---------------------------------------------------------------------------
def setup(tmp_path):
    root = str(tmp_path)
    os.mkdir(os.path.join(root, "EP-JAM"))
    Path(root, "top.cfm").write_bytes(b"alpha beta")
    Path(root, "EP-JAM", "ReportCard.cfm").write_bytes(b"<td>GPA</td>\n<td>Rank</td>\n")
    Path(root, "EP-JAM", "Other.cfm").write_bytes(b"not selected")
    en = with_case_files(
        enumerate_workspaces([root]),
        [{"rel": "EP-JAM/ReportCard.cfm", "folder": root, "score": 1, "reason": ""}],
        [root],
    )
    return root, en


def edit(file, folder, old_str="<td>GPA</td>"):
    return {"file": file, "folder": folder, "oldStr": old_str, "newStr": "<td>Weighted GPA</td>", "why": ""}


def test_selected_subfolder_file_is_editable_by_relative_path(tmp_path):
    root, en = setup(tmp_path)
    r = check_edit(edit("EP-JAM/ReportCard.cfm", root), en, [root])
    assert r["ok"] is True, r.get("problem")
    assert r["line"] == 1


def test_windows_style_relative_path_is_folded(tmp_path):
    root, en = setup(tmp_path)
    r = check_edit(edit("EP-JAM\\ReportCard.cfm", root), en, [root])
    assert r["ok"] is True, r.get("problem")
    assert r["file"] == "EP-JAM/ReportCard.cfm"


def test_traversal_absolute_and_unselected_are_refused(tmp_path):
    root, en = setup(tmp_path)
    for f in ["../ReportCard.cfm", "EP-JAM/../top.cfm", os.path.join(root, "EP-JAM", "ReportCard.cfm"), "EP-JAM/Other.cfm"]:
        r = check_edit(edit(f, root, "not selected"), en, [root])
        assert r["ok"] is False, f"{f} should be refused"


def test_top_level_files_still_work(tmp_path):
    root, en = setup(tmp_path)
    assert check_edit(edit("top.cfm", root, "alpha"), en, [root])["ok"] is True


# ---------------------------------------------------------------------------
# check_edit details
# ---------------------------------------------------------------------------
def test_check_edit_problems(tmp_path):
    root, en = setup(tmp_path)
    assert check_edit({**edit("", root)}, en, [root])["problem"] == "The plan named no file."
    assert check_edit(edit("top.cfm", root, ""), en, [root])["problem"] == "The plan gave no text to replace."
    same = {**edit("top.cfm", root, "alpha"), "newStr": "alpha"}
    assert check_edit(same, en, [root])["problem"] == "The before and after text are identical — nothing to do."
    big = {**edit("top.cfm", root, "alpha"), "newStr": "é" * (32 * 1024 + 1)}
    assert check_edit(big, en, [root])["problem"] == "The edit is too large to apply safely (over 64 KB)."
    r = check_edit(edit("nope.cfm", root, "x"), en, [root])
    assert r["problem"].startswith('"nope.cfm" isn\'t one of the editable files')
    r = check_edit(edit("top.cfm", root, "gamma"), en, [root])
    assert r["problem"].startswith("The 'before' text doesn't appear in the file.")
    Path(root, "top.cfm").write_bytes(b"x x x")
    r = check_edit(edit("top.cfm", root, "x"), en, [root])
    assert r["problem"] == ("The 'before' text appears 3 times, so the edit is ambiguous. "
                            "It needs more surrounding context to be applied.")


def test_check_edit_case_insensitive_census_and_default_folder(tmp_path):
    root, en = setup(tmp_path)
    r = check_edit({**edit("TOP.CFM", root.upper(), "beta")}, en, [root])
    assert r["ok"] and r["file"] == "top.cfm" and r["folder"] == root
    r = check_edit({**edit("top.cfm", "", "beta")}, en, [root])  # folder defaults to paths[0]
    assert r["ok"] and r["folder"] == root


def test_check_edit_oversized_target(tmp_path):
    root, en = setup(tmp_path)
    en = {**en, "files": [{**f, "size": 600 * 1024} if f["name"] == "top.cfm" else f for f in en["files"]]}
    assert check_edit(edit("top.cfm", root, "alpha"), en, [root])["problem"] == \
        "The file is larger than 512 KB — too big to rewrite safely."


def test_eol_helpers():
    assert to_eol("a\r\nb\nc", "lf") == "a\nb\nc"
    assert to_eol("a\r\nb\nc", "crlf") == "a\r\nb\r\nc"
    assert dominant_eol("a\r\nb\r\nc\n") == "crlf"
    assert dominant_eol("a\r\nb\nc\n") == "lf"  # bare \n counted without the \r\n ones
    assert dominant_eol("no newline") == "lf"


def test_crlf_file_matches_lf_old_str_and_reports_line(tmp_path):
    root = str(tmp_path)
    Path(root, "t.cfm").write_bytes(b"one\r\ntwo\r\nthree\r\n")
    en = enumerate_workspaces([root])
    r = check_edit({"file": "t.cfm", "folder": root, "oldStr": "two\nthree", "newStr": "2\n3", "why": ""}, en, [root])
    assert r["ok"] and r["eol"] == "crlf" and r["line"] == 2
    assert list(r) == ["file", "folder", "oldStr", "newStr", "why", "ok", "eol", "line"]


# ---------------------------------------------------------------------------
# extract_plan_json
# ---------------------------------------------------------------------------
def test_extract_last_json_fence():
    raw = 'x\n```json\n{"a": 1}\n```\nmore\n```JSON  \n{"edits": [], "b": 2}\n```\n'
    assert extract_plan_json(raw) == {"edits": [], "b": 2}


def test_extract_falls_back_to_plain_fence_with_edits():
    raw = '```\n{"nope": 1}\n```\n```\n{"edits": [1]}\n```\n```\nnot json\n```'
    assert extract_plan_json(raw) == {"edits": [1]}


def test_extract_errors():
    with pytest.raises(FixPlanError, match="produced no JSON plan block"):
        extract_plan_json("just prose\n```\n{\"x\": 1}\n```")
    with pytest.raises(FixPlanError, match=r"^The run produced a JSON plan that couldn't be parsed \(.*\)\. Nothing was changed\.$"):
        extract_plan_json("```json\n{broken\n```")


# ---------------------------------------------------------------------------
# build_fix_stdin — byte-identical to the TS build
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("key", ["fix_full", "fix_min"])
def test_fix_stdin_matches_ts(key):
    assert build_fix_stdin(py_opts(INPUTS[key])) == TS_EXPECTED[key]


def test_clip_format():
    assert fix_plan.clip("abcdef", 3) == "abc\n… [clipped, 6 chars total]"
    assert fix_plan.clip(None, 3) == ""
    assert fix_plan.clip("abc", 3) == "abc"


# ---------------------------------------------------------------------------
# validate_plan
# ---------------------------------------------------------------------------
BRIEF = {"number": "SR00012345", "subject": "GPA wrong"}


def test_validate_plan_requests_and_edits(tmp_path):
    root, en = setup(tmp_path)
    parsed = {
        "problem": "p", "whyItFixes": "w", "notFixed": "n", "risks": "r", "assumptions": "a",
        "requests": [
            {"id": "1", "text": " Fix GPA ", "status": " Addressed "},
            {"id": "1", "text": "Rank label", "status": "partial"},
            {"id": "", "text": "Logo", "status": "weird"},
            {"id": "4", "text": "   ", "status": "addressed"},
            "garbage",
        ],
        "edits": [
            {**edit("EP-JAM/ReportCard.cfm", root), "requestId": "1'"},
            {**edit("top.cfm", root, "alpha"), "requestId": "nope"},
            "garbage",
        ],
        # Fields the plan no longer carries are ignored.
        "references": ["/Training/Vars"],
        "skills": {"selected": [{"name": "x"}]},
        "skillFeedback": ["x"],
    }
    plan = validate_plan(parsed, en=en, paths=[root], brief=BRIEF, report="the report", model="m")
    assert plan["requests"] == [
        {"id": "1", "text": "Fix GPA", "status": "addressed"},
        {"id": "1'", "text": "Rank label", "status": "partial"},
        {"id": "3", "text": "Logo", "status": "unstated"},
    ]
    assert plan["edits"][0]["ok"] and plan["edits"][0]["requestId"] == "1'"
    assert plan["edits"][1]["ok"] and "requestId" not in plan["edits"][1]
    assert plan["edits"][2]["ok"] is False and plan["edits"][2]["problem"] == "The plan named no file."
    assert plan["warnings"] == []
    assert plan["confidence"] == "unstated"
    assert re.fullmatch(r"SR00012345-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z", plan["id"])
    assert plan["id"] == "SR00012345-" + re.sub(r"[:.]", "-", plan["createdAt"])
    assert list(plan) == ["version", "id", "caseNumber", "caseSubject", "paths", "model", "createdAt", "report",
                          "problem", "whyItFixes", "notFixed", "risks", "assumptions", "confidence", "requests",
                          "warnings", "steps", "stepStatus", "missingInputs", "edits", "toolCalls", "usage"]
    assert plan["toolCalls"] == [] and plan["usage"] == {}


def test_validate_plan_limits_and_garbage(tmp_path):
    root, en = setup(tmp_path)
    plan = validate_plan(None, en=en, paths=[root], brief=BRIEF, report="")
    assert "model" not in plan and plan["edits"] == [] and plan["requests"] == []
    many = {"edits": [edit("top.cfm", root, "alpha")] * 21}
    w = validate_plan(many, en=en, paths=[root], brief=BRIEF, report="")["warnings"]
    assert len(w) == 1 and w[0].startswith("Unusually broad: 21 edits, against a guideline of 20. ")
    with pytest.raises(FixPlanError, match="past the hard 200-edit ceiling"):
        validate_plan({"edits": [{}] * 201}, en=en, paths=[root], brief=BRIEF, report="")


# ---------------------------------------------------------------------------
# Store + apply
# ---------------------------------------------------------------------------
@pytest.fixture
def fixes(monkeypatch, tmp_path):
    d = tmp_path / "fixes"
    monkeypatch.setattr(fix_plan, "FIXES_DIR", str(d))
    return d


def make_ws(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "crlf.cfm").write_bytes(b"<tr>\r\n  <td>GPA</td>\r\n</tr>\r\n<p>Rank $1</p>\r\n")
    (ws / "lf.cfm").write_bytes(b"alpha\nbeta\n")
    return str(ws)


def stored_plan(root, en, edits, **kw):
    plan = validate_plan({"edits": edits, "problem": "p"}, en=en, paths=[root], brief=BRIEF, report=kw.get("report", "# Plan\n"))
    save_plan(plan)
    return plan


def test_save_load_latest(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = stored_plan(root, en, [])
    d = fixes / plan["id"]
    assert json.loads((d / "plan.json").read_text(encoding="utf-8")) == plan
    assert (d / "report.md").read_text(encoding="utf-8") == "# Plan\n"
    assert json.loads((fixes / "latest.json").read_text(encoding="utf-8")) == {"id": plan["id"], "caseNumber": "SR00012345"}
    assert load_plan(plan["id"]) == plan
    assert latest_plan() == plan and latest_plan("SR00012345") == plan
    assert latest_plan("SR99999999") is None
    assert load_plan("../../etc") is None
    with pytest.raises(FixPlanError, match="Unknown plan id."):
        fix_plan.plan_dir("SR1-2026")
    blank = validate_plan({}, en=en, paths=[root], brief={"number": "SR00000002", "subject": ""}, report="  ")
    save_plan(blank)
    assert not (fixes / blank["id"] / "report.md").exists()


def test_apply_crlf_two_edits_one_file(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = stored_plan(root, en, [
        {"file": "crlf.cfm", "folder": root, "oldStr": "<tr>\n  <td>GPA</td>", "newStr": "<tr>\n  <td>Weighted GPA</td>", "why": ""},
        # `$&`-style text in the replacement must land literally.
        {"file": "crlf.cfm", "folder": root, "oldStr": "<p>Rank $1</p>", "newStr": "<p>Rank $& \\1</p>", "why": ""},
        {"file": "lf.cfm", "folder": root, "oldStr": "beta", "newStr": "gamma", "why": ""},
    ])
    assert [e["ok"] for e in plan["edits"]] == [True, True, True]
    res = apply_plan(plan["id"], en, [root])
    assert res["files"] == 2
    assert [(a["file"], a["line"]) for a in res["applied"]] == [("crlf.cfm", 1), ("crlf.cfm", 4), ("lf.cfm", 2)]
    assert Path(root, "crlf.cfm").read_bytes() == b"<tr>\r\n  <td>Weighted GPA</td>\r\n</tr>\r\n<p>Rank $& \\1</p>\r\n"
    assert Path(root, "lf.cfm").read_bytes() == b"alpha\ngamma\n"
    backup = Path(res["backupDir"], "1", "crlf.cfm")
    assert res["applied"][0]["backup"] == str(backup)
    assert backup.read_bytes() == b"<tr>\r\n  <td>GPA</td>\r\n</tr>\r\n<p>Rank $1</p>\r\n"
    assert res["planDir"] == str(fixes / plan["id"]) and res["backupDir"] == str(fixes / plan["id"] / "backup")

    saved = load_plan(plan["id"])
    assert saved["appliedAt"] and list(saved)[-1] == "appliedAt"
    with pytest.raises(FixPlanError, match="^This plan was already applied at "):
        apply_plan(plan["id"], en, [root])
    # Reapply is allowed by flag, but the content check refuses it: the text is gone.
    with pytest.raises(FixPlanError, match="None of this plan's edits can be applied"):
        apply_plan(plan["id"], en, [root], reapply=True)
    # The re-check on load shows the same thing.
    assert [e["ok"] for e in recheck_plan(saved, en, [root])["edits"]] == [False, False, False]


def test_apply_refuses_overlap(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = stored_plan(root, en, [
        {"file": "lf.cfm", "folder": root, "oldStr": "alpha\nbeta", "newStr": "A", "why": ""},
        {"file": "lf.cfm", "folder": root, "oldStr": "beta", "newStr": "B", "why": ""},
    ])
    with pytest.raises(FixPlanError) as ei:
        apply_plan(plan["id"], en, [root])
    assert str(ei.value) == ("Nothing was changed. Two edits in this plan overlap in lf.cfm: after the earlier ones "
                             "were applied, the 'before' text for the edit at line 2 no longer appears. Re-plan the fix.")
    assert Path(root, "lf.cfm").read_bytes() == b"alpha\nbeta\n"
    assert not (fixes / plan["id"] / "backup").exists()


def test_apply_is_all_or_nothing(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = stored_plan(root, en, [
        {"file": "lf.cfm", "folder": root, "oldStr": "beta", "newStr": "B", "why": ""},
        {"file": "crlf.cfm", "folder": root, "oldStr": "<td>GPA</td>", "newStr": "x", "why": ""},
    ])
    # The file moves on after planning: the second edit no longer matches.
    Path(root, "crlf.cfm").write_bytes(b"changed\r\n")
    with pytest.raises(FixPlanError) as ei:
        apply_plan(plan["id"], en, [root])
    msg = str(ei.value)
    assert msg.startswith("Nothing was changed. crlf.cfm: The 'before' text doesn't appear in the file.")
    assert msg.endswith(" Re-plan the fix so it matches the files as they are now.")
    assert Path(root, "lf.cfm").read_bytes() == b"alpha\nbeta\n"
    assert "appliedAt" not in load_plan(plan["id"])


def test_apply_unknown_plan(fixes):
    with pytest.raises(FixPlanError, match="no longer stored"):
        apply_plan("SR00012345-2026-01-01T00-00-00-000Z", {"files": []}, ["C:\\x"])


def test_backup_slot_by_folder(tmp_path, fixes):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(), b.mkdir()
    (a / "r.cfm").write_bytes(b"one")
    (b / "r.cfm").write_bytes(b"two")
    paths = [str(a), str(b)]
    en = enumerate_workspaces(paths)
    plan = validate_plan({"edits": [
        {"file": "r.cfm", "folder": str(a), "oldStr": "one", "newStr": "1"},
        {"file": "r.cfm", "folder": str(b), "oldStr": "two", "newStr": "2"},
    ]}, en=en, paths=paths, brief=BRIEF, report="")
    save_plan(plan)
    res = apply_plan(plan["id"], en, paths)
    assert res["files"] == 2
    assert Path(res["backupDir"], "1", "r.cfm").read_bytes() == b"one"
    assert Path(res["backupDir"], "2", "r.cfm").read_bytes() == b"two"


# ---------------------------------------------------------------------------
# plan_fix against the scripted fake CLI
# ---------------------------------------------------------------------------
@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(claude_run, "_LAUNCHER", Launcher(sys.executable, [FAKE], False))

    def script(**s):
        p = tmp_path / "script.json"
        s.setdefault("argv_out", str(tmp_path / "argv.json"))
        s.setdefault("stdin_out", str(tmp_path / "stdin.txt"))
        p.write_text(json.dumps(s), encoding="utf-8")
        monkeypatch.setenv("FAKE_SCRIPT", str(p))

    return script


def run_plan(opts):
    out = {"chunks": [], "tools": [], "done": None, "error": None, "calls": 0}

    async def main():
        def on_done(r):
            out["calls"] += 1
            out["done"] = r

        def on_error(err, partial, salvaged):
            out["calls"] += 1
            out["error"], out["partial"], out["salvaged"] = err, partial, salvaged

        h = fix_plan.plan_fix(opts, on_chunk=out["chunks"].append, on_done=on_done, on_error=on_error,
                              on_tool_use=out["tools"].append)
        await h.wait()

    asyncio.run(main())
    assert out["calls"] == 1
    return out


PLAN_BLOCK = ("Explanation.\n\n```json\n" + json.dumps({
    "problem": "GPA label", "requests": [{"id": "1", "text": "Rename GPA", "status": "addressed"}],
    "edits": [{"file": "lf.cfm", "folder": "{ROOT}", "oldStr": "beta", "newStr": "gamma", "why": "w", "requestId": "1"}],
    "confidence": "high",
}) + "\n```\n")


def plan_opts(root, en, **kw):
    return {"paths": [root], "enumeration": en, "brief": {**BRIEF, "status": "Open", "account": "A", "createdOn": "c",
            "description": "d", "timeline": []}, "model": "m-plan", **kw}


def test_plan_fix_harvests_and_saves(tmp_path, fixes, fake):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    block = PLAN_BLOCK.replace("{ROOT}", root.replace("\\", "\\\\"))
    fake(chunks=[block[:20], block[20:]], tools=[{"name": "Read", "input": {"file_path": "lf.cfm"}}],
         result={"result": "x", "total_cost_usd": 0.25, "usage": {"total_tokens": 10}, "duration_ms": 5})
    opts = plan_opts(root, en, analysis_markdown="## Purpose\nx")
    out = run_plan(opts)
    d = out["done"]
    assert d["costUsd"] == 0.25 and d["totalTokens"] == 10 and d["durationMs"] == 5 and "planError" not in d
    plan = d["plan"]
    assert plan["model"] == "m-plan" and plan["report"] == block
    assert plan["edits"][0]["ok"] and plan["edits"][0]["requestId"] == "1"
    assert plan["confidence"] == "high"
    assert plan["toolCalls"] == [{"name": "Read", "target": "lf.cfm"}]
    assert plan["usage"] == {"costUsd": 0.25, "totalTokens": 10}
    assert load_plan(plan["id"]) == plan and latest_plan() == plan
    rec = json.loads((tmp_path / "argv.json").read_text(encoding="utf-8"))
    argv = rec["argv"]
    assert argv[argv.index("-p") + 1] == fix_plan.FIX_INSTRUCTION
    assert argv[argv.index("--append-system-prompt") + 1] == fix_plan.FIX_SYSTEM_PROMPT
    assert fix_plan.PLAN_SCHEMA_TEXT in fix_plan.FIX_SYSTEM_PROMPT
    assert argv[argv.index("--tools") + 1] == "Read,Glob,Grep"
    assert "Edit" in argv[argv.index("--disallowed-tools") + 1].split(",")
    assert "--safe-mode" in argv and argv[argv.index("--setting-sources") + 1] == "user"
    assert (tmp_path / "stdin.txt").read_text(encoding="utf-8") == build_fix_stdin(opts)


def test_plan_fix_without_block_reports_plan_error(tmp_path, fixes, fake):
    root = make_ws(tmp_path)
    fake(chunks=["only prose"], result={"result": "x"})
    out = run_plan(plan_opts(root, enumerate_workspaces([root])))
    assert out["done"]["plan"] is None
    assert out["done"]["planError"].startswith("The run finished but produced no JSON plan block")
    assert not fixes.exists()


def test_plan_fix_salvages_on_timeout(tmp_path, fixes, fake):
    root = make_ws(tmp_path)
    block = PLAN_BLOCK.replace("{ROOT}", root.replace("\\", "\\\\"))
    fake(chunks=[block], hang=True)
    out = run_plan(plan_opts(root, enumerate_workspaces([root]), timeout_ms=1500))
    assert "timed out" in out["error"].message
    assert out["partial"] == block
    s = out["salvaged"]
    assert s and s["edits"][0]["ok"] and s["usage"] == {}
    assert load_plan(s["id"]) == s


def test_fix_timeout(monkeypatch):
    monkeypatch.setattr(fix_plan, "read_env_file", lambda: {})
    monkeypatch.delenv("CREATIO_FIX_TIMEOUT_MS", raising=False)
    assert fix_plan.fix_timeout_ms() == 600_000
    monkeypatch.setenv("CREATIO_FIX_TIMEOUT_MS", "1")
    assert fix_plan.fix_timeout_ms() == 10_000
    monkeypatch.setenv("CREATIO_FIX_TIMEOUT_MS", "1000000")
    assert fix_plan.fix_timeout_ms() == 900_000


# ---------------------------------------------------------------------------
# Steps: per-step apply, final report
# ---------------------------------------------------------------------------
def test_validate_plan_steps(tmp_path):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    parsed = {
        "steps": [
            {"n": 3, "kind": "manual", "instructions": "Edit the template", "skill": "ignored", "url": "ignored"},
            {"n": 7, "instructions": "Deploy"},
            {"n": 9, "kind": "edit", "instructions": "Tell the client"},
        ],
        "edits": [
            {"file": "lf.cfm", "folder": root, "oldStr": "beta", "newStr": "B", "why": "", "step": 3},
            {"file": "crlf.cfm", "folder": root, "oldStr": "<p>Rank $1</p>", "newStr": "x", "why": "", "step": "42"},
        ],
        "missingInputs": ["the school code", ""],
    }
    plan = validate_plan(parsed, en=en, paths=[root], brief=BRIEF, report="")
    steps = plan["steps"]
    assert [(s["n"], s["kind"]) for s in steps] == [(1, "edit"), (2, "manual"), (3, "manual"), (4, "edit")]
    assert all("skill" not in s and "url" not in s for s in steps)
    assert steps[3]["instructions"].startswith("Unassigned edits") and not steps[3]["implicit"]
    assert [e["step"] for e in plan["edits"]] == [1, 4]
    assert "_rawStep" not in plan["edits"][0]
    assert plan["missingInputs"] == ["the school code"]
    assert plan["stepStatus"] == {}
    w = " ".join(plan["warnings"])
    assert "1 edit(s) named no step" in w


def test_validate_plan_without_steps_gets_one_implicit_step(tmp_path):
    root = make_ws(tmp_path)
    plan = validate_plan({"edits": [{"file": "lf.cfm", "folder": root, "oldStr": "beta", "newStr": "B", "why": ""}]},
                         en=enumerate_workspaces([root]), paths=[root], brief=BRIEF, report="")
    assert plan["steps"] == [{
        "n": 1, "kind": "edit", "instructions": "Apply the edits below.", "inputs": "",
        "output": "1 edit(s) to workspace files",
        "verify": "Each edit's new text is in its file, and the old text is gone.", "implicit": True}]
    assert plan["edits"][0]["step"] == 1
    assert validate_plan({}, en=enumerate_workspaces([root]), paths=[root], brief=BRIEF, report="")["steps"] == []


def stepped_plan(root, en):
    plan = validate_plan({
        "steps": [{"n": 1, "instructions": "edit lf"}, {"n": 2, "kind": "manual", "instructions": "deploy"},
                  {"n": 3, "instructions": "edit crlf"}],
        "edits": [
            {"file": "lf.cfm", "folder": root, "oldStr": "beta", "newStr": "beta gamma", "why": "", "step": 1},
            {"file": "crlf.cfm", "folder": root, "oldStr": "<td>GPA</td>", "newStr": "<td>W</td>", "why": "", "step": 3},
        ],
    }, en=en, paths=[root], brief=BRIEF, report="")
    save_plan(plan)
    return plan


def test_apply_step_by_step(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = stepped_plan(root, en)
    with pytest.raises(FixPlanError, match="Finish step 1 before step 3"):
        apply_plan(plan["id"], en, [root], step=3)
    with pytest.raises(FixPlanError, match="has no step 9"):
        apply_plan(plan["id"], en, [root], step=9)

    res = apply_plan(plan["id"], en, [root], step=1)
    assert Path(root, "lf.cfm").read_bytes() == b"alpha\nbeta gamma\n"
    assert Path(root, "crlf.cfm").read_bytes().startswith(b"<tr>\r\n  <td>GPA</td>")  # step 3 untouched
    assert res["backupDir"] == str(fixes / plan["id"] / "backup" / "step-1")
    assert Path(res["backupDir"], "1", "lf.cfm").read_bytes() == b"alpha\nbeta\n"
    saved = load_plan(plan["id"])
    assert saved["stepStatus"]["1"]["state"] == "applied" and "appliedAt" not in saved
    # An insertion (old text inside the new) verifies on the new text alone.
    assert fix_plan.verify_step(saved, 1, en, [root]) == {
        "ok": True, "checks": [{"file": "lf.cfm", "folder": root, "ok": True}]}
    with pytest.raises(FixPlanError, match="Step 1 was already applied"):
        apply_plan(plan["id"], en, [root], step=1)

    with pytest.raises(FixPlanError, match="manual step with no edits"):
        apply_plan(plan["id"], en, [root], step=2)
    fix_plan.mark_step(plan["id"], 2, note="deployed")
    with pytest.raises(FixPlanError, match="Step 3 has edits"):
        fix_plan.mark_step(plan["id"], 3)
    assert load_plan(plan["id"])["stepStatus"]["2"]["note"] == "deployed"

    apply_plan(plan["id"], en, [root], step=3)
    saved = load_plan(plan["id"])
    assert saved["appliedAt"]
    assert fix_plan.verify_step(saved, 3, en, [root])["ok"] is True
    assert fix_plan.verify_step(saved, 2, en, [root]) == {"ok": True, "checks": []}

    rep = fix_plan.final_report(plan["id"])
    md = rep["markdown"]
    assert rep["pending"] == [] and Path(rep["path"]).read_text(encoding="utf-8") == md
    assert "1. [applied] (edit) edit lf" in md and "2. [done] (manual) deploy" in md
    assert "lf.cfm` (line 2)" in md and "Nothing was staged or committed" in md
    assert load_plan(plan["id"])["finishedAt"]


def test_verify_step_detects_a_revert(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = stepped_plan(root, en)
    apply_plan(plan["id"], en, [root], step=1)
    Path(root, "lf.cfm").write_bytes(b"alpha\nbeta\n")
    v = fix_plan.verify_step(load_plan(plan["id"]), 1, en, [root])
    assert v["ok"] is False and v["checks"][0]["problem"] == "The new text isn't in the file."


def test_skip_step_and_report_open_items(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = stepped_plan(root, en)
    fix_plan.mark_step(plan["id"], 1, skipped=True, note="not now")
    with pytest.raises(FixPlanError, match="already skipped"):
        fix_plan.mark_step(plan["id"], 1, skipped=True)
    md = fix_plan.final_report(plan["id"])["markdown"]
    assert "Step 1 was skipped. (not now)" in md and "Step 2 was not completed." in md
    assert "No files were changed." in md


# ---------------------------------------------------------------------------
# Revisions: the engineer's feedback reshapes the remaining steps
# ---------------------------------------------------------------------------
def test_revision_keeps_locked_steps_and_renumbers_the_rest(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    prior = stepped_plan(root, en)
    apply_plan(prior["id"], en, [root], step=1)
    prior = load_plan(prior["id"])
    assert [s["n"] for s in fix_plan.locked_steps(prior)] == [1]

    revised = validate_plan({
        "steps": [{"n": 1, "kind": "manual", "instructions": "confirm grade bands"},
                  {"n": 2, "instructions": "edit crlf differently"}],
        "edits": [{"file": "crlf.cfm", "folder": root, "oldStr": "<td>GPA</td>", "newStr": "<td>GPA (9-12)</td>",
                   "why": "", "step": 2}],
    }, en=en, paths=[root], brief=BRIEF, report="", prior=prior, feedback="grade bands are 9-12")

    assert [(s["n"], s["kind"], s["instructions"]) for s in revised["steps"]] == [
        (1, "edit", "edit lf"), (2, "manual", "confirm grade bands"), (3, "edit", "edit crlf differently")]
    assert [(e["file"], e["step"]) for e in revised["edits"]] == [("lf.cfm", 1), ("crlf.cfm", 3)]
    assert revised["stepStatus"] == {"1": prior["stepStatus"]["1"]}
    assert revised["revision"] == 2 and revised["revisionOf"] == prior["id"] and revised["id"] != prior["id"]
    assert revised["feedback"] == [{"text": "grade bands are 9-12", "at": revised["createdAt"]}]
    assert "appliedAt" not in revised
    # The revision applies from where the prior left off.
    save_plan(revised)
    with pytest.raises(FixPlanError, match="Step 1 was already applied"):
        apply_plan(revised["id"], en, [root], step=1)
    fix_plan.mark_step(revised["id"], 2)
    apply_plan(revised["id"], en, [root], step=3)
    assert b"<td>GPA (9-12)</td>" in Path(root, "crlf.cfm").read_bytes()
    assert load_plan(revised["id"])["appliedAt"]

    again = validate_plan({}, en=en, paths=[root], brief=BRIEF, report="", prior=load_plan(revised["id"]), feedback="x")
    assert again["revision"] == 3 and [f["text"] for f in again["feedback"]] == ["grade bands are 9-12", "x"]


def test_check_revision_request(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    prior = stepped_plan(root, en)
    assert fix_plan.check_revision_request(prior, "  drop step 2 ") == "drop step 2"
    for bad, msg in [("", "Say what to change"), (None, "Say what to change"), ("x" * 2001, "under 2000")]:
        with pytest.raises(FixPlanError, match=msg):
            fix_plan.check_revision_request(prior, bad)
    with pytest.raises(FixPlanError, match="no longer stored"):
        fix_plan.check_revision_request(None, "x")
    with pytest.raises(FixPlanError, match="revised 9 times"):
        fix_plan.check_revision_request({**prior, "revision": 10}, "x")
    done = {**prior, "stepStatus": {"1": {"state": "applied"}, "2": {"state": "done"}, "3": {"state": "skipped"}}}
    with pytest.raises(FixPlanError, match="nothing left to revise"):
        fix_plan.check_revision_request(done, "x")


def test_fix_stdin_revision_blocks(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    prior = stepped_plan(root, en)
    apply_plan(prior["id"], en, [root], step=1)
    prior = {**load_plan(prior["id"]), "feedback": [{"text": "earlier note", "at": "t"}], "revision": 2}
    s = build_fix_stdin({"paths": [root], "enumeration": en, "brief": BRIEF, "prior_plan": prior,
                         "feedback": "grade bands are 9-12"})
    assert "=== CURRENT PLAN — revision 2, the plan you are revising ===" in s
    body = s[s.index("=== CURRENT PLAN"):]
    assert '"status": "LOCKED — applied"' in body and '"status": "pending"' in body
    assert '"stillApplies": true' in body
    assert "  1. earlier note" in body
    assert s.rstrip().endswith("=== REVIEWER FEEDBACK — from the engineer running this tool. Follow it. ===\n"
                               "grade bands are 9-12\n\n=== END OF DATA ===")
    assert s.index("=== CASE") < s.index("=== CURRENT PLAN")
    assert "CURRENT PLAN" not in build_fix_stdin({"paths": [root], "enumeration": en, "brief": BRIEF})
    assert "REVISIONS:" in fix_plan.FIX_SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# New files
# ---------------------------------------------------------------------------
def create(file, folder, body="<cfoutput>new</cfoutput>\n", step=None):
    e = {"create": True, "file": file, "folder": folder, "newStr": body, "why": "new report"}
    if step is not None:
        e["step"] = step
    return e


@pytest.mark.parametrize("name, problem", [
    ("../escape.cfm", "isn't a usable"),
    ("PTA/../../x.cfm", "isn't a usable"),
    ("/abs.cfm", "must be relative"),
    ("C:/x.cfm", "must be relative"),
    ("C:x.cfm", "must be relative"),
    (".hidden/x.cfm", "isn't a usable"),
    ("PTA/.env", "isn't a usable"),
    ("server.key", "secret or key"),
    ("id_rsa.txt", "secret or key"),
    ("CON.cfm", "reserved name"),
    ("a/b/c/d/e.cfm", "at most 4"),
    ("logo.png", "Only text/source"),
    ("PTA/bad|name.cfm", "isn't a usable"),
    ("lf.cfm", "already exists"),
    ("", "named no file"),
])
def test_create_refuses_unsafe_names(tmp_path, name, problem):
    root = make_ws(tmp_path)
    r = check_edit(create(name, root), enumerate_workspaces([root]), [root])
    assert r["ok"] is False and problem in r["problem"], r.get("problem")


def test_create_validates_folder_content_and_accepts_a_good_path(tmp_path):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    assert "workspace folders" in check_edit(create("x.cfm", str(tmp_path)), en, [root])["problem"]
    assert "no content" in check_edit(create("x.cfm", root, "  \n"), en, [root])["problem"]
    assert "256 KB" in check_edit(create("x.cfm", root, "x" * (256 * 1024 + 1)), en, [root])["problem"]
    ok = check_edit(create("PTA-FL\\Progress Report.cfm", root.upper()), en, [root])
    assert ok["ok"] and ok["file"] == "PTA-FL/Progress Report.cfm" and ok["folder"] == root
    assert ok["eol"] == "crlf" and ok["line"] == 1 and ok["oldStr"] == ""
    assert check_edit(create("notes.md", root), en, [root])["eol"] == "lf"


def test_create_refuses_a_junction_out_of_the_workspace(tmp_path):
    root = make_ws(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = Path(root, "link")
    try:
        os.symlink(outside, link, target_is_directory=True)
    except OSError:
        # Windows without the symlink privilege: a junction needs none.
        import subprocess
        if sys.platform != "win32" or subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True
        ).returncode:
            pytest.skip("links not permitted here")
    r = check_edit(create("link/x.cfm", root), enumerate_workspaces([root]), [root])
    assert r["ok"] is False and "outside the workspace" in r["problem"]


def test_apply_creates_new_files_verifies_and_reports(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = validate_plan({
        "steps": [{"n": 1, "instructions": "build the pair"}, {"n": 2, "instructions": "edit lf"}],
        "edits": [
            create("PTA-FL/ProgressReport.cfm", root, "<cfinclude template=\"x.htm\">\n<p>hi</p>\n", 1),
            create("PTA-FL/ProgressReport.htm", root, "<table></table>\n", 1),
            {"file": "lf.cfm", "folder": root, "oldStr": "beta", "newStr": "B", "why": "", "step": 2},
        ],
    }, en=en, paths=[root], brief=BRIEF, report="")
    save_plan(plan)
    assert [e.get("create", False) for e in plan["edits"]] == [True, True, False]

    res = apply_plan(plan["id"], en, [root], step=1)
    cfm = Path(root, "PTA-FL", "ProgressReport.cfm")
    assert cfm.read_bytes() == b"<cfinclude template=\"x.htm\">\r\n<p>hi</p>\r\n"  # CRLF for templates
    assert res["files"] == 2 and all(a["created"] for a in res["applied"])
    saved = load_plan(plan["id"])
    assert [c["file"] for c in saved["created"]] == ["PTA-FL/ProgressReport.cfm", "PTA-FL/ProgressReport.htm"]
    assert json.loads(Path(res["backupDir"], "created.json").read_text(encoding="utf-8"))[0]["step"] == 1
    assert fix_plan.verify_step(saved, 1, en, [root])["ok"] is True
    cfm.write_text("changed", encoding="utf-8")
    assert fix_plan.verify_step(saved, 1, en, [root])["checks"][0]["problem"].startswith("The new file's content")

    # The created files join the census, so a revision can edit them.
    en2 = fix_plan.with_created_files(en, saved)
    assert {"PTA-FL/ProgressReport.cfm", "PTA-FL/ProgressReport.htm"} <= {f["name"] for f in en2["files"]}
    edit_created = {"file": "PTA-FL/ProgressReport.htm", "folder": root, "oldStr": "<table>", "newStr": "<table border=1>", "why": ""}
    assert check_edit(edit_created, en2, [root])["ok"] is True
    assert check_edit(edit_created, en, [root])["ok"] is False
    revised = validate_plan({}, en=en2, paths=[root], brief=BRIEF, report="", prior=saved, feedback="x")
    assert revised["created"] == saved["created"]

    apply_plan(plan["id"], en, [root], step=2)
    md = fix_plan.final_report(plan["id"])["markdown"]
    assert "ProgressReport.cfm` — **new file** (step 1)" in md and "not undone automatically" in md
    assert "lf.cfm` (line 2)" in md and "ProgressReport.htm` (line" not in md


def test_apply_create_is_all_or_nothing(tmp_path, fixes):
    root = make_ws(tmp_path)
    en = enumerate_workspaces([root])
    plan = validate_plan({"edits": [create("new/a.cfm", root), create("new/b.cfm", root)]},
                         en=en, paths=[root], brief=BRIEF, report="")
    save_plan(plan)
    # b.cfm appears after planning: re-check refuses, and a.cfm is not created either.
    Path(root, "new").mkdir()
    Path(root, "new", "b.cfm").write_text("theirs", encoding="utf-8")
    with pytest.raises(FixPlanError, match="already exists"):
        apply_plan(plan["id"], en, [root])
    assert not Path(root, "new", "a.cfm").exists()
    assert Path(root, "new", "b.cfm").read_text(encoding="utf-8") == "theirs"

    dup = validate_plan({"edits": [create("d.cfm", root), create("D.cfm", root)]}, en=en, paths=[root], brief=BRIEF, report="")
    save_plan(dup)
    with pytest.raises(FixPlanError, match="same new file twice"):
        apply_plan(dup["id"], en, [root])
    assert not Path(root, "d.cfm").exists()


def test_create_new_file_never_overwrites(tmp_path):
    t = tmp_path / "x.cfm"
    t.write_text("keep", encoding="utf-8")
    with pytest.raises(FileExistsError):
        fix_plan.create_new_file(str(t), "new")
    assert t.read_text(encoding="utf-8") == "keep"


# ---------------------------------------------------------------------------
# Case info: which district
# ---------------------------------------------------------------------------
def test_fix_stdin_prints_case_codes(tmp_path):
    root = make_ws(tmp_path)
    brief = {**BRIEF, "account": "Praise Tab Academy",
             "codes": {"districtCode": "PTA-FL", "schoolCode": "PTA", "institutionId": "1234"},
             "info": [{"label": "Service", "value": "Custom Reports"}, {"label": "School Code", "value": "PTA"}]}
    s = build_fix_stdin({"paths": [root], "enumeration": enumerate_workspaces([root]), "brief": brief})
    assert ("Account: Praise Tab Academy\nDistrict code: PTA-FL\nSchool code: PTA\nInstitution ID: 1234\n"
            "Service: Custom Reports\nOpened:") in s
    assert "WHICH CLIENT:" in fix_plan.FIX_SYSTEM_PROMPT and "RULES FOR NEW FILES" in fix_plan.FIX_SYSTEM_PROMPT
