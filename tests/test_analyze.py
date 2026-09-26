from creatio_case_lookup import analyze, claude_run
from creatio_case_lookup.analyze import (
    MAX_CASES,
    PRESET_INSTRUCTIONS,
    SYSTEM_PROMPT,
    build_context,
    clip,
    format_case,
)


def case(n, **kw):
    c = {"Id": f"id{n}", "Number": f"SR{n:08d}", "Subject": f"Subj {n}", "CreatedOn": "2026-01-01",
         "Status": "Open", "Owner": "o", "Account": "Acme", "Contact": ""}
    c.update(kw)
    return c


def test_clip():
    assert clip(None) == ""
    assert clip("  hi ﻿") == "hi"
    assert clip("abcdef", 3) == "abc …[truncated]"
    assert clip("x" * 1000) == "x" * 1000
    assert clip("x" * 1001) == "x" * 1000 + " …[truncated]"


def test_format_case_with_timeline():
    tl = [{"kind": "FEED", "ts": f"t{i}", "text": f"post {i}"} for i in range(13)]
    tl.append({"kind": "EMAIL", "ts": "te", "text": "mail", "sender": "a@x", "recipient": None})
    c = case(1, detail={"description": "desc", "timeline": tl})
    out = format_case(c, 0).split("\n")
    assert out[0] == "### Case 1: SR00000001 — Subj 1"
    assert out[1] == "Status: Open | Account: Acme | Contact: ? | Created: 2026-01-01"
    assert out[2] == "Description: desc"
    assert out[3] == "Timeline (14 entries, showing last 12):"
    assert out[4] == "- [FEED t2] (feed post) post 2"
    assert out[-1] == "- [EMAIL te] (a@x → ?) mail"
    assert len(out) == 4 + 12


def test_format_case_latest_only_and_long_entries():
    c = case(2, detail={"latest": {"kind": "FEED", "ts": "t", "text": "y" * 600}})
    lines = format_case(c, 4).split("\n")
    assert lines[0].startswith("### Case 5: ")
    assert lines[2] == "Timeline (1 entry):"
    assert lines[3] == "- [FEED t] (feed post) " + "y" * 500 + " …[truncated]"
    assert format_case(case(3), 0).count("\n") == 1


def test_build_context_truncation():
    cases = [case(i) for i in range(MAX_CASES + 3)]
    r = build_context(cases)
    assert r["truncatedCases"] == 3
    assert r["text"].startswith(
        "# 25 Creatio support cases (of 28; 3 omitted to keep the analysis focused)\n\n### Case 1:")
    assert "### Case 25:" in r["text"] and "### Case 26:" not in r["text"]

    one = build_context([case(1)])
    assert one == {"text": "# 1 Creatio support case\n\n" + format_case(case(1), 0), "truncatedCases": 0}


def capture_spec(monkeypatch):
    seen = {}

    def fake_run(spec, on_chunk, on_done, on_error, on_tool_use=None):
        seen["spec"] = spec
        on_done({"costUsd": 1.5, "resultText": "r"})
        return claude_run.RunHandle()

    monkeypatch.setattr(analyze, "run_claude", fake_run)
    return seen


def test_ask_question_goes_to_stdin(monkeypatch):
    seen = capture_spec(monkeypatch)
    done = []
    analyze.analyze_cases({"preset": "ask", "question": "  why? ", "cases": [case(1)]},
                          lambda c: None, done.append, lambda e: None)
    s = seen["spec"]
    assert s.instruction == ("Answer the user's QUESTION (below) using ONLY the Creatio "
                             "support-case data on stdin.")
    assert s.stdin == "QUESTION: why?\n\n" + build_context([case(1)])["text"]
    assert "why?" not in s.instruction and "why?" not in s.system_prompt
    assert s.cwd == "isolated" and s.setting_sources == [] and s.tools is None
    assert s.model == analyze.DEFAULT_MODEL == "claude-opus-5-5"
    assert s.system_prompt == SYSTEM_PROMPT
    assert done == [{"costUsd": 1.5, "resultText": "r", "truncatedCases": 0}]


def test_preset_no_question_prefix(monkeypatch):
    seen = capture_spec(monkeypatch)
    analyze.analyze_cases({"preset": "themes", "question": "ignored", "cases": [], "model": "m"},
                          lambda c: None, lambda m: None, lambda e: None)
    assert seen["spec"].instruction == PRESET_INSTRUCTIONS["themes"]
    assert seen["spec"].stdin == "# 0 Creatio support cases\n\n"
    assert seen["spec"].model == "m"


def test_reexports():
    assert analyze.ClaudeCliError is claude_run.ClaudeCliError
    assert analyze.claude_available is claude_run.claude_available
