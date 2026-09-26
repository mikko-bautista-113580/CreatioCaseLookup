"""HTTP contract tests for creatio_case_lookup.server (no network, no real claude).

Everything that touches disk is pointed at tmp_path: the .env, the .analysis/
store, the case briefs and the fix-plan store. Creatio calls are monkeypatched
on the server module; the Claude CLI is replaced by tests/fake_claude.py (or a
tiny per-test script) through claude_run's launcher cache.
"""

import json
import sys
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from creatio_case_lookup import (
    case_brief,
    claude_run,
    env,
    fix_plan,
    paths,
    server,
    workspace,
)
from creatio_case_lookup.claude_run import Launcher
from creatio_case_lookup.creatio_client import AuthError

FAKE = str(Path(__file__).with_name("fake_claude.py"))
CASE = "SR00012345"


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    envp = tmp_path / ".env"
    envp.write_text(
        "CREATIO_BASE_URL=https://example.creatio.test\n"
        "CREATIO_ASPXAUTH=ABCDEFGHIJKLMNOPQRSTUVWXYZ\n"
        "CREATIO_BPMCSRF=short\n"
        "CREATIO_BPMLOADER=\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(paths, "ENV_PATH", envp)
    monkeypatch.setattr(env, "ENV_PATH", envp)
    ad = tmp_path / ".analysis"
    monkeypatch.setattr(paths, "ANALYSIS_DIR", ad)
    monkeypatch.setattr(workspace, "ANALYSIS_DIR", ad)
    monkeypatch.setattr(workspace, "INDEX_PATH", ad / "index.json")
    monkeypatch.setattr(case_brief, "CASES_DIR", ad / "cases")
    monkeypatch.setattr(fix_plan, "FIXES_DIR", str(ad / "fixes"))
    # No claude on PATH unless a test installs the fake.
    monkeypatch.setattr(claude_run, "_LAUNCHER", None)
    ws = tmp_path / "proj"
    ws.mkdir()
    return {"tmp": tmp_path, "env": envp, "analysis": ad, "ws": ws}


@pytest.fixture
def client(sandbox):
    with TestClient(server.app) as c:
        yield c


def fake_claude(monkeypatch, mode="ok", script=None):
    monkeypatch.setattr(claude_run, "_LAUNCHER", Launcher(sys.executable, [script or FAKE], False))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", mode)


def parse_sse(text):
    """Same rules as public/app.js consumeSse: blocks split on a blank line,
    `event:` / `data:` lines, blocks without data skipped."""
    out = []
    buf = text
    while (sep := buf.find("\n\n")) != -1:
        block, buf = buf[:sep], buf[sep + 2 :]
        event, data = "message", ""
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        if not data:
            continue
        out.append((event, json.loads(data)))
    assert buf == "", "stream must end on a frame boundary"
    return out


def bind_case(number=CASE, subject="Report card logo", description="Please update the report card."):
    row = {"Id": "11111111-2222-3333-4444-555555555555", "Number": number, "Subject": subject,
           "Status": "New", "Owner": "Me", "Account": "School", "Contact": "C", "CreatedOn": "2026-01-01T00:00:00Z"}
    brief = case_brief.build_brief(row, {"description": description, "timeline": []}, [])
    case_brief.save_brief(brief)
    case_brief.set_bound_case(number)
    return brief


# ---------------------------------------------------------------------------
# Plain JSON routes
# ---------------------------------------------------------------------------
def test_meta_shape(client, sandbox):
    workspace.set_workspace_paths([str(sandbox["ws"])])
    r = client.get("/api/meta")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/json; charset=utf-8"
    d = r.json()
    assert list(d) == ["baseUrl", "allowlist", "maxTop", "statuses", "openActive", "aiAvailable",
                       "workspacePaths", "workspaceCap", "workspaceCase", "userName"]
    assert d["aiAvailable"] is False
    assert d["workspacePaths"] == [str(sandbox["ws"])]
    assert d["workspaceCap"] == 10
    assert d["workspaceCase"] == ""
    assert "New" in d["statuses"] and isinstance(d["statuses"], list)


@pytest.mark.parametrize("display,full", [
    ("Bautista, Lester Mikko", "Lester Mikko Bautista"),
    ("Melissa Holland", "Melissa Holland"),
    ("  Holland,   Melissa ", "Melissa Holland"),
    ("Madonna", "Madonna"),
    ("", ""),
])
def test_user_full_name(display, full):
    assert server.user_full_name(display) == full


def test_meta_user_name_from_os(client, monkeypatch):
    monkeypatch.setattr(server, "_USER_NAME", None)
    monkeypatch.setattr(server, "_display_name", lambda: "Holland, Melissa")
    assert client.get("/api/meta").json()["userName"] == "Melissa Holland"


def test_config_masks_cookies(client):
    d = client.get("/api/config").json()
    assert d["baseUrl"] == "https://example.creatio.test"
    assert d["cookies"] == {
        "aspx": "ABCD" + "•" * 18 + "WXYZ",
        "csrf": "•••••",
        "loader": "",
        "hasAspx": True,
        "hasCsrf": True,
        "hasLoader": False,
    }
    assert server.mask("x" * 40) == "xxxx" + "•" * 20 + "xxxx"


def test_unknown_api_route_is_json_404(client):
    r = client.get("/api/unknown")
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "message": "No API route GET /api/unknown"}
    # Right path, wrong method.
    r = client.post("/api/meta")
    assert r.status_code == 404
    assert r.json()["message"] == "No API route POST /api/meta"


def test_invalid_json_body(client):
    r = client.post("/api/workspace", content=b"{nope", headers={"Content-Type": "application/json"})
    assert r.status_code == 500
    assert r.json() == {"error": "server", "message": "Invalid JSON body."}


def test_workspace_post_validation(client, sandbox):
    r = client.post("/api/workspace", json={})
    assert r.status_code == 400
    assert r.json() == {"error": "path", "message": "Enter the folder you're working in."}

    missing = str(sandbox["tmp"] / "nope")
    r = client.post("/api/workspace", json={"paths": [str(sandbox["ws"]), missing]})
    assert r.status_code == 400
    assert r.json() == {"error": "path", "index": 1, "message": "That folder doesn't exist."}

    (sandbox["ws"] / "a.txt").write_text("hello\n", encoding="utf-8")
    r = client.post("/api/workspace", json={"paths": [str(sandbox["ws"]), str(sandbox["ws"]).upper(), ""]})
    assert r.status_code == 200
    d = r.json()
    assert d["saved"] is True and d["paths"] == [str(sandbox["ws"])]
    assert d["enumeration"]["count"] == 1
    assert workspace.get_workspace_paths() == [str(sandbox["ws"])]

    r = client.post("/api/workspace", json={"clear": True})
    assert r.json() == {"saved": True, "cleared": True, "paths": [], "enumeration": None}
    assert workspace.get_workspace_paths() == []


def test_workspace_files(client, sandbox):
    r = client.get("/api/workspace/files")
    assert r.status_code == 400
    assert r.json() == {"error": "path", "message": "No workspace folder configured."}

    (sandbox["ws"] / "a.cfm").write_text("<cfoutput/>", encoding="utf-8")
    workspace.set_workspace_paths([str(sandbox["ws"])])
    d = client.get("/api/workspace/files").json()
    assert d["count"] == 1 and d["files"][0]["name"] == "a.cfm"
    assert d["files"][0]["folder"] == str(sandbox["ws"])

    r = client.get("/api/workspace/files", params={"path": "relative\\path"})
    assert r.status_code == 400 and r.json()["error"] == "path"


def test_workspace_get_and_case_get(client, sandbox):
    d = client.get("/api/workspace").json()
    assert d == {"paths": [], "valid": False, "maxPaths": 3, "cap": 10, "aiAvailable": False,
                 "analysis": {"directory": None, "files": []}}
    assert client.get("/api/workspace/case").json() == {"number": "", "brief": None, "ageHours": None}
    bind_case()
    d = client.get("/api/workspace/case").json()
    assert d["number"] == CASE and d["brief"]["number"] == CASE and d["ageHours"] == 0
    assert client.get("/api/workspace/fix").json() == {"plan": None}


def test_auth_error_maps_to_401(client, monkeypatch):
    async def boom(_opts=None, **_kw):
        raise AuthError("Cookies expired.")

    monkeypatch.setattr(server, "find_cases", boom)
    r = client.post("/api/cases", json={"mode": "recent"})
    assert r.status_code == 401
    assert r.json() == {"error": "auth", "message": "Cookies expired."}


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------
def test_static_index_and_traversal(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/html; charset=utf-8"
    assert r.content == (paths.PUBLIC_DIR / "index.html").read_bytes()

    r = client.get("/app.js")
    assert r.headers["content-type"] == "text/javascript; charset=utf-8"

    r = client.get("/missing.html")
    assert r.status_code == 404 and r.text == "Not found"
    assert r.headers["content-type"] == "text/plain"

    for evil in ("/..%2f..%2fpyproject.toml", "/..%5c..%5cpyproject.toml", "/%2e%2e/pyproject.toml"):
        r = client.get(evil)
        assert r.status_code in (403, 404), evil
        assert "[project]" not in r.text


# ---------------------------------------------------------------------------
# SSE
# ---------------------------------------------------------------------------
def test_cases_sse_framing(client, monkeypatch):
    rows = [{"Id": f"id{i}", "Number": f"SR000{i}", "Status": s} for i, s in enumerate(["New", "New", "Resolved"])]

    async def find(opts=None, **_kw):
        assert opts["mode"] == "owner" and opts["guids"] == ["g"]
        return {"cases": rows, "truncated": False, "caveats": []}

    async def detail(c, kinds):
        if c["Id"] == "id1":
            raise RuntimeError("detail broke")
        return {"description": f"desc {c['Id']} — é", "kinds": list(kinds)}

    monkeypatch.setattr(server, "find_cases", find)
    monkeypatch.setattr(server, "get_case_detail", detail)

    r = client.post("/api/cases", json={"mode": "owner", "guids": ["g"], "detail": ["summary", "description"]})
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert r.headers["cache-control"] == "no-cache"
    assert "\r" not in r.text
    # Compact JSON, non-ASCII kept as-is.
    assert '"needDetail":true' in r.text and "— é" in r.text

    ev = parse_sse(r.text)
    assert ev[0] == ("found", {"cases": rows, "tally": {"New": 2, "Resolved": 1}, "truncated": False,
                               "caveats": [], "needDetail": True, "total": 3})
    assert ev[-1] == ("done", {})
    cases = {d["index"]: d for e, d in ev if e == "case"}
    assert cases[1] == {"index": 1, "detail": {}, "error": "detail broke"}
    assert cases[0]["detail"]["description"] == "desc id0 — é"
    progress = [d for e, d in ev if e == "progress"]
    assert [p["done"] for p in progress] == [1, 2, 3] and progress[-1]["total"] == 3

    # Summary only: found + done, no detail fetches.
    ev = parse_sse(client.post("/api/cases", json={"mode": "owner", "guids": ["g"]}).text)
    assert [e for e, _ in ev] == ["found", "done"] and ev[0][1]["needDetail"] is False


def test_cases_sse_auth_error_stops(client, monkeypatch):
    rows = [{"Id": "a", "Number": "SR0001", "Status": "New"}]

    async def find(opts=None, **_kw):
        return {"cases": rows, "truncated": False, "caveats": []}

    async def detail(c, kinds):
        raise AuthError("expired")

    monkeypatch.setattr(server, "find_cases", find)
    monkeypatch.setattr(server, "get_case_detail", detail)
    ev = parse_sse(client.post("/api/cases", json={"mode": "recent", "detail": ["timeline"]}).text)
    assert [e for e, _ in ev] == ["found", "error"]
    assert ev[1][1] == {"kind": "auth", "message": "expired"}


def test_workspace_analyze_validation_errors(client, sandbox, monkeypatch):
    # No claude: refused before anything else.
    r = client.post("/api/workspace/analyze", json={})
    assert r.status_code == 400 and r.json()["message"].startswith("The Claude CLI was not found.")

    fake_claude(monkeypatch)
    for i in range(3):
        (sandbox["ws"] / f"f{i}.cfm").write_text("x", encoding="utf-8")
    (sandbox["env"]).write_text(sandbox["env"].read_text(encoding="utf-8") + "CREATIO_WORKSPACE_FILE_CAP=2\n",
                                encoding="utf-8")
    workspace.set_workspace_paths([str(sandbox["ws"])])

    r = client.post("/api/workspace/analyze", json={"mode": "directory"})
    assert r.status_code == 400
    d = r.json()
    assert d["error"] == "over_cap" and d["count"] == 3 and d["cap"] == 2 and len(d["files"]) == 3
    assert d["message"].startswith("That folder has 3 top-level files — more than the 2-file quick-analysis limit.")

    r = client.post("/api/workspace/analyze", json={"mode": "file", "file": "../secret.txt"})
    assert r.status_code == 400
    assert r.json()["message"] == '"../secret.txt" is not one of the top-level source files in the workspace.'

    r = client.post("/api/workspace/analyze", json={"mode": "case"})
    assert r.status_code == 400
    assert r.json() == {"error": "case", "message": "No case is bound. Pick one in phase 1 first."}

    bind_case(subject="Zyxwvut quarterly", description="Qwertyuiop asdfghjkl zxcvbnm.")
    r = client.post("/api/workspace/analyze", json={"mode": "case"})
    assert r.status_code == 400
    d = r.json()
    assert d["error"] == "no_match"
    assert d["message"].startswith(f"No files in the workspace matched {CASE}'s keywords (")
    assert d["scope"]["caseNumber"] == CASE and d["scope"]["files"] == []


def test_workspace_analyze_streams_with_fake_claude(client, sandbox, monkeypatch):
    fake_claude(monkeypatch, "ok")
    (sandbox["ws"] / "a.cfm").write_text("<cfoutput>hi</cfoutput>", encoding="utf-8")
    workspace.set_workspace_paths([str(sandbox["ws"])])

    r = client.post("/api/workspace/analyze", json={})
    assert r.status_code == 200
    ev = parse_sse(r.text)
    names = [e for e, _ in ev]
    assert names[0] == "start" and names[-1] == "done"
    start = ev[0][1]
    assert start == {"paths": [str(sandbox["ws"])], "mode": "directory", "target": None, "targetFolder": None,
                     "count": 1, "cap": 10, "overCap": False, "skipped": start["skipped"]}
    assert "".join(d["text"] for e, d in ev if e == "chunk") == "Hello wörld"
    assert ("tool", {"name": "Read", "target": "a.txt"}) in ev
    done = ev[-1][1]
    assert done["saved"] is True and done["report"].endswith(".md")
    assert done["costUsd"] == 0.0123 and done["totalTokens"] == 15 and done["durationMs"] == 42
    assert done["filesAnalyzed"] == 1 and done["toolCalls"] == 1

    # The stored report is now visible through the read-back routes.
    d = client.get("/api/workspace").json()
    assert d["valid"] is True and d["analysis"]["directory"] is not None and d["stale"] is False
    got = client.get("/api/workspace/analysis").json()
    assert got["meta"]["mode"] == "directory" and "Hello wörld" in got["markdown"]


PLAN_SCRIPT = r'''
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.buffer.read()
plan = {"problem": "Wrong greeting", "whyItFixes": "Says goodbye", "notFixed": "", "risks": "", "assumptions": "",
        "confidence": "high", "requests": [{"id": "1", "text": "Change greeting", "status": "addressed"}],
        "edits": [{"file": "a.txt", "folder": "", "oldStr": "hello", "newStr": "goodbye", "why": "asked",
                   "requestId": "1"}]}
text = "Plan below.\n\n```json\n" + json.dumps(plan) + "\n```\n"
def emit(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
emit({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}})
emit({"type": "result", "subtype": "success", "result": text, "total_cost_usd": 0.5, "duration_ms": 7})
'''


def test_fix_plan_and_apply_round_trip(client, sandbox, monkeypatch):
    script = sandbox["tmp"] / "fake_plan.py"
    script.write_text(textwrap.dedent(PLAN_SCRIPT), encoding="utf-8")
    fake_claude(monkeypatch, script=str(script))
    target = sandbox["ws"] / "a.txt"
    target.write_bytes(b"say hello\n")
    workspace.set_workspace_paths([str(sandbox["ws"])])

    # Validation first: nothing bound yet.
    r = client.post("/api/workspace/fix/plan")
    assert r.status_code == 400 and r.json()["message"] == "No case is bound. Pick one in phase 1 first."

    bind_case()
    r = client.post("/api/workspace/fix/plan")
    assert r.status_code == 200
    ev = parse_sse(r.text)
    assert ev[0][0] == "start"
    assert ev[0][1]["caseNumber"] == CASE and ev[0][1]["files"] == 1 and ev[0][1]["hasAnalysis"] is False
    assert ev[0][1]["analysisGenerated"] is None
    assert list(ev[0][1]) == ["caseNumber", "caseSubject", "paths", "files", "hasAnalysis", "analysisGenerated",
                              "analysisStale", "analysisFiles", "analysisMode", "revising"]
    assert ev[-1][0] == "done"
    done = ev[-1][1]
    assert done["planError"] is None and done["costUsd"] == 0.5 and done["durationMs"] == 7
    plan = done["plan"]
    assert plan["caseNumber"] == CASE and plan["edits"][0]["ok"] is True
    assert target.read_bytes() == b"say hello\n", "planning must not write"

    # A reload gets the same plan back, re-checked.
    again = client.get("/api/workspace/fix").json()["plan"]
    assert again["id"] == plan["id"] and again["edits"][0]["ok"] is True

    assert client.post("/api/workspace/fix/apply", json={}).json() == {"error": "server", "message": "No plan id given."}
    r = client.post("/api/workspace/fix/apply", json={"id": plan["id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d) == {"applied", "backupDir"}
    assert d["applied"][0]["file"] == "a.txt"
    assert target.read_bytes() == b"say goodbye\n"
    assert Path(d["applied"][0]["backup"]).read_bytes() == b"say hello\n"

    # Applying twice is refused as a fix error.
    r = client.post("/api/workspace/fix/apply", json={"id": plan["id"]})
    assert r.status_code == 400 and r.json()["error"] == "fix"
    r = client.post("/api/workspace/fix/apply", json={"id": "../../etc"})
    assert r.status_code == 400 and r.json()["error"] == "fix"


def test_fix_plan_steps_round_trip(client, sandbox, monkeypatch):
    script = sandbox["tmp"] / "fake_plan.py"
    stepped = PLAN_SCRIPT.replace(
        '"requestId": "1"}]}',
        '"requestId": "1", "step": 1}], "steps": [{"n": 1, "instructions": "edit"}, '
        '{"n": 2, "kind": "manual", "instructions": "deploy"}]}',
    )
    assert stepped != PLAN_SCRIPT
    script.write_text(textwrap.dedent(stepped), encoding="utf-8")
    fake_claude(monkeypatch, script=str(script))
    target = sandbox["ws"] / "a.txt"
    target.write_bytes(b"say hello\n")
    workspace.set_workspace_paths([str(sandbox["ws"])])
    bind_case()
    plan = parse_sse(client.post("/api/workspace/fix/plan").text)[-1][1]["plan"]
    assert [(s["n"], s["kind"]) for s in plan["steps"]] == [(1, "edit"), (2, "manual")]
    pid = plan["id"]

    r = client.post("/api/workspace/fix/step-done", json={"id": pid, "step": 2})
    assert r.status_code == 400 and "Finish step 1" in r.json()["message"]
    r = client.post("/api/workspace/fix/apply", json={"id": pid, "step": "1"})
    assert r.status_code == 400 and r.json()["error"] == "fix"

    r = client.post("/api/workspace/fix/apply", json={"id": pid, "step": 1})
    assert r.status_code == 200, r.text
    assert r.json()["verify"] == {"ok": True, "checks": [{"file": "a.txt", "folder": str(sandbox["ws"]), "ok": True}]}
    assert target.read_bytes() == b"say goodbye\n"

    r = client.post("/api/workspace/fix/step-done", json={"id": pid, "step": 2, "note": "shipped"})
    assert r.status_code == 200 and r.json()["stepStatus"]["2"]["state"] == "done"

    r = client.post("/api/workspace/fix/finish", json={"id": pid})
    assert r.status_code == 200
    fin = r.json()
    assert fin["pending"] == [] and "a.txt" in fin["markdown"] and Path(fin["path"]).exists()
    assert client.get("/api/workspace/fix").json()["plan"]["finishedAt"]


def test_fix_revise_round_trip(client, sandbox, monkeypatch):
    stdin_file = sandbox["tmp"] / "stdin.txt"
    stepped = PLAN_SCRIPT.replace(
        '"requestId": "1"}]}',
        '"requestId": "1", "step": 1}], "steps": [{"n": 1, "instructions": "edit"}, '
        '{"n": 2, "kind": "manual", "instructions": "deploy"}]}',
    ).replace("sys.stdin.buffer.read()", f"open({str(stdin_file)!r}, 'wb').write(sys.stdin.buffer.read())")
    script = sandbox["tmp"] / "fake_plan.py"
    script.write_text(textwrap.dedent(stepped), encoding="utf-8")
    fake_claude(monkeypatch, script=str(script))
    (sandbox["ws"] / "a.txt").write_bytes(b"say hello\n")
    workspace.set_workspace_paths([str(sandbox["ws"])])
    bind_case()
    first = parse_sse(client.post("/api/workspace/fix/plan").text)[-1][1]["plan"]
    assert client.post("/api/workspace/fix/apply", json={"id": first["id"], "step": 1}).status_code == 200

    r = client.post("/api/workspace/fix/revise", json={"id": first["id"], "feedback": "  "})
    assert r.status_code == 400 and r.json()["message"] == "Say what to change in the plan."
    assert client.post("/api/workspace/fix/revise", json={}).json()["message"] == "No plan id given."

    r = client.post("/api/workspace/fix/revise", json={"id": first["id"], "feedback": "deploy to staging first"})
    assert r.status_code == 200
    ev = parse_sse(r.text)
    assert ev[0][1]["revising"] == {"id": first["id"], "revision": 2, "locked": 1}
    plan = ev[-1][1]["plan"]
    assert plan["revision"] == 2 and plan["revisionOf"] == first["id"]
    assert [(s["n"], s["instructions"]) for s in plan["steps"]] == [(1, "edit"), (2, "edit"), (3, "deploy")]
    assert plan["stepStatus"]["1"]["state"] == "applied" and list(plan["stepStatus"]) == ["1"]
    sent = stdin_file.read_text(encoding="utf-8")
    assert "=== REVIEWER FEEDBACK" in sent and sent.rstrip().endswith("deploy to staging first\n\n=== END OF DATA ===")
    assert '"status": "LOCKED — applied"' in sent
    # The revision is now the plan a reload shows.
    assert client.get("/api/workspace/fix").json()["plan"]["id"] == plan["id"]


CASE_INFO = [
    {"label": "Contact", "value": "Rose"}, {"label": "Account", "value": "Praise Tab Academy"},
    {"label": "Service", "value": "Custom Reports"}, {"label": "Service Area", "value": ""},
    {"label": "Resolution time", "value": "2026-10-01"},
    {"label": "SIS District code", "value": "PTA-FL"}, {"label": "School Code", "value": "PTA"},
    {"label": "Institution ID Number", "value": "1234"},
]


def test_bind_stores_the_case_codes(client, monkeypatch):
    row = {"Id": "11111111-2222-3333-4444-555555555555", "Number": CASE, "Subject": "Progress Report Template",
           "Status": "In progress", "Owner": "Me", "Account": "Praise Tab Academy", "Contact": "Rose", "CreatedOn": "x"}

    async def find(opts=None, **_kw):
        return {"cases": [row], "truncated": False, "caveats": []}

    async def detail(c, kinds):
        return {"description": "Build a progress report.", "timeline": []}

    async def info(case_id):
        assert case_id == row["Id"]
        return CASE_INFO

    async def attachments(case_id):
        return []

    monkeypatch.setattr(server, "find_cases", find)
    monkeypatch.setattr(server, "get_case_detail", detail)
    monkeypatch.setattr(server, "get_case_info", info)
    monkeypatch.setattr(server, "get_attachments", attachments)
    b = client.post("/api/workspace/case", json={"number": CASE}).json()["brief"]
    assert b["codes"] == {"districtCode": "PTA-FL", "schoolCode": "PTA", "institutionId": "1234"}
    assert b["info"] == [{"label": "Service", "value": "Custom Reports"},
                         {"label": "SIS District code", "value": "PTA-FL"}, {"label": "School Code", "value": "PTA"},
                         {"label": "Institution ID Number", "value": "1234"}]
    assert case_brief.load_brief(CASE)["codes"]["districtCode"] == "PTA-FL"

    # A failing case-info read never fails the bind.
    async def broken(case_id):
        raise RuntimeError("no such field")

    monkeypatch.setattr(server, "get_case_info", broken)
    b = client.post("/api/workspace/case", json={"number": CASE}).json()["brief"]
    assert "codes" not in b


def test_old_brief_gets_its_codes_filled_on_the_fly(sandbox, monkeypatch):
    import asyncio
    brief = bind_case()
    assert "codes" not in brief
    calls = []

    async def info(case_id):
        calls.append(case_id)
        return CASE_INFO

    monkeypatch.setattr(server, "get_case_info", info)
    got = asyncio.run(server.ensure_case_info(brief))
    assert got["codes"]["districtCode"] == "PTA-FL"
    assert case_brief.load_brief(CASE)["codes"]["schoolCode"] == "PTA"
    asyncio.run(server.ensure_case_info(got))
    assert len(calls) == 1  # already filled: no second read

    async def broken(case_id):
        raise AuthError("expired")

    monkeypatch.setattr(server, "get_case_info", broken)
    old = bind_case(number="SR00000009")
    assert "codes" not in asyncio.run(server.ensure_case_info(old))
